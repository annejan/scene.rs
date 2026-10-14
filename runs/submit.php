<?php
// scene.rs/runs: an upload, a run for the board or a bug report, into the
// spool for the worker (server/runs/worker.py), which replays it as the
// user `runs`. This side only checks what can be checked cheaply and
// writes two files: <id>.txt the recording, <id>.json what was said. It
// never reads a recording beyond its first bytes, and serves nothing back
// but the id to ask after (runs/data/status/<id>.json).

declare(strict_types=1);

define('SPOOL', getenv('RUNS_SPOOL') ?: '/srv/runs/spool');  // another for a test
const MAX_FILE   = 512 * 1024;
const MAX_SPOOL  = 200;  // uploads waiting, at most
const PER_HOUR   = 12;   // from one address

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function done(int $code, array $body): never {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function no(string $why, int $code = 400): never {
    done($code, ['ok' => false, 'error' => $why]);
}

// Plain text, one line, no control characters, at most $max characters.
function line(string $s, int $max): string {
    $s = preg_replace('/[\x00-\x1f\x7f]+/u', ' ', $s) ?? '';
    return mb_substr(trim($s), 0, $max);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') no('POST only', 405);
// From this site's page only.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$site   = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
if ($origin !== 'https://scene.rs' && $site !== 'same-origin') no('from scene.rs/runs only', 403);
// A field people do not see: a bot fills it.
if (($_POST['website'] ?? '') !== '') no('no');

$kind = ($_POST['kind'] ?? 'run') === 'bug' ? 'bug' : 'run';
$file = $_FILES['recording'] ?? null;
if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) no('no recording came with it');
if ($file['size'] <= 0 || $file['size'] > MAX_FILE) no('a recording is at most 512 KB');
$text = file_get_contents($file['tmp_name']);
if ($text === false || strlen($text) !== $file['size']) no('the recording could not be read');
if (str_contains($text, "\0") || !mb_check_encoding($text, 'UTF-8')) no('that is not a Portals recording (not text)');
if (!preg_match('/^chamber:/m', $text)) no('that is not a Portals recording (no chamber: line)');

$nick = line((string)($_POST['nick'] ?? ''), 24);
if ($kind === 'run' && $nick === '') no('a name to put on the board, please');
$video = line((string)($_POST['video'] ?? ''), 300);
if ($video !== '' && !preg_match('#^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s<>"]*)?$#i', $video)) no('a video link starts with https://');
$note    = mb_substr(trim(preg_replace('/[\x00-\x08\x0b-\x1f\x7f]/u', '', (string)($_POST['note'] ?? '')) ?? ''), 0, $kind === 'bug' ? 2000 : 500);
$contact = $kind === 'bug' ? line((string)($_POST['contact'] ?? ''), 200) : '';
if ($kind === 'bug' && $note === '') no('say what went wrong, please');

// Not too many waiting, nor too many from one address: counted by a hash
// of it with a secret that changes daily, kept an hour, never the address.
$waiting = count(glob(SPOOL . '/*.json') ?: []);
if ($waiting >= MAX_SPOOL) no('the board is busy: try again in a few minutes', 503);
$rate = SPOOL . '/.rate';
if (!is_dir($rate)) @mkdir($rate, 0770);
$secretf = $rate . '/secret-' . gmdate('Ymd');
if (!is_file($secretf)) @file_put_contents($secretf, bin2hex(random_bytes(16)));
$who   = hash('sha256', (string)@file_get_contents($secretf) . ($_SERVER['REMOTE_ADDR'] ?? ''));
$mine  = $rate . '/' . substr($who, 0, 32);
$now   = time();
$times = array_filter(array_map('intval', file_exists($mine) ? file($mine, FILE_IGNORE_NEW_LINES) : []),
                      fn($t) => $t > $now - 3600);
if (count($times) >= PER_HOUR) no('that is a lot of uploads: try again in an hour', 429);
$times[] = $now;
@file_put_contents($mine, implode("\n", $times) . "\n", LOCK_EX);
foreach (glob($rate . '/*') ?: [] as $f)  // yesterday's and older go
    if (filemtime($f) < $now - 86400 * 2) @unlink($f);

$id   = bin2hex(random_bytes(8));
$meta = [
    'id'       => $id,
    'kind'     => $kind,
    'nick'     => $nick,
    'tas'      => ($_POST['tas'] ?? '') === '1',
    'video'    => $video,
    'note'     => $note,
    'contact'  => $contact,
    'source'   => ($_POST['source'] ?? '') === 'badge' ? 'badge' : 'file',
    'filename' => line(basename((string)($file['name'] ?? '')), 80),
    'received' => gmdate('c'),
];
// The recording first, what was said last: the worker takes an upload by its .json.
if (@file_put_contents(SPOOL . "/$id.txt", $text) === false) no('could not keep it: try again later', 500);
@chmod(SPOOL . "/$id.txt", 0644);
$tmp = SPOOL . "/.$id.json";
if (@file_put_contents($tmp, json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) === false ||
    !@chmod($tmp, 0644) || !@rename($tmp, SPOOL . "/$id.json")) {
    @unlink(SPOOL . "/$id.txt");
    no('could not keep it: try again later', 500);
}
done(200, ['ok' => true, 'id' => $id, 'kind' => $kind]);
