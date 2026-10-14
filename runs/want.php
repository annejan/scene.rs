<?php
// scene.rs/runs: someone on a run's page asks for its film. Only leaves
// spool/want-<id> for the worker (server/runs/worker.py), which lists the
// asked-for runs for the film renderer (server/films/render.py).

declare(strict_types=1);

define('SPOOL', getenv('RUNS_SPOOL') ?: '/srv/runs/spool');  // another for a test
define('PUBLIC_DIR', getenv('RUNS_PUBLIC') ?: '/srv/runs/public');
const PER_HOUR = 20;  // asks from one address

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function done(int $code, array $body): never {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') done(405, ['ok' => false, 'error' => 'POST only']);
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$site   = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
if ($origin !== 'https://scene.rs' && $site !== 'same-origin') done(403, ['ok' => false, 'error' => 'from scene.rs/runs only']);
$id = (string)($_POST['id'] ?? '');
if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_file(PUBLIC_DIR . "/run/$id.json"))
    done(404, ['ok' => false, 'error' => 'no such run']);
if (is_file(SPOOL . "/want-$id")) done(200, ['ok' => true]);  // asked already

// As submit.php: counted by a hash of the address with a daily secret, never the address.
$rate = SPOOL . '/.rate';
if (!is_dir($rate)) @mkdir($rate, 0770);
$secretf = $rate . '/secret-' . gmdate('Ymd');
if (!is_file($secretf)) @file_put_contents($secretf, bin2hex(random_bytes(16)));
// An IPv6 address counts by its /64: one home has the whole of it.
$addr = (string)($_SERVER['REMOTE_ADDR'] ?? '');
$bin  = @inet_pton($addr);
if ($bin !== false && strlen($bin) === 16) $addr = bin2hex(substr($bin, 0, 8)) . '::/64';
$who   = hash('sha256', 'want' . (string)@file_get_contents($secretf) . $addr);
$mine  = $rate . '/' . substr($who, 0, 32);
$now   = time();
$times = array_filter(array_map('intval', file_exists($mine) ? file($mine, FILE_IGNORE_NEW_LINES) : []),
                      fn($t) => $t > $now - 3600);
if (count($times) >= PER_HOUR) done(429, ['ok' => false, 'error' => 'that is a lot of films: try again in an hour']);
$times[] = $now;
@file_put_contents($mine, implode("\n", $times) . "\n", LOCK_EX);
if (random_int(0, 49) === 0)  // now and then, as submit.php does: yesterday's and older go
    foreach (glob($rate . '/*') ?: [] as $f)
        if (filemtime($f) < $now - 86400 * 2) @unlink($f);

if (@touch(SPOOL . "/want-$id") === false) done(500, ['ok' => false, 'error' => 'could not ask: try again later']);
@chmod(SPOOL . "/want-$id", 0664);
done(200, ['ok' => true]);
