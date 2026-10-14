#!/usr/bin/env python3
"""The stories page without its script: what a search engine, a link preview or a browser
without JavaScript sees of scene.rs/stories.

    tools/stories_static.py

From stories/index.json (made by Portals' tools/stories_site.py) it writes into
stories/index.html, between its marker comments:
    <!-- ld --> ... <!-- /ld -->          the page as structured data (JSON-LD): the stories, the trailer
    <!-- stats --> ... <!-- /stats -->    how many stories and chambers
    <!-- packs --> ... <!-- /packs -->    a card for each story, as stories.js draws them
and stories/share.jpg, the 1200 x 630 picture a shared link shows. stories.js draws the
cards again when it runs, with the buttons that need it. Run it after stories_site.py.
"""

import html
import json
import os
import re

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORIES = os.path.join(ROOT, "stories")
SITE = "https://scene.rs/stories/"
FONTS = ["/usr/share/fonts/truetype/LiberationSans-Bold.ttf",
         "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]


def esc(s):
    return html.escape(s or "", quote=True)


def kb(n):
    return "%d bytes" % n if n < 1024 else "%d KB" % round(n / 1024)


def short_date(iso):
    y, m, d = iso[:10].split("-")
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    return "%d %s %s" % (int(d), months[int(m) - 1], y)


def playable(p):
    return p["rounds"] if p["desk"] else p["chambers"]


def inside(p):
    """The chamber list as stories.js numbers it: each route on from the fork, after the
    join on from the longest route. Returns its <li>s and how many one playthrough plays."""
    items, n, fork, longest = [], 0, None, 0
    for c in p.get("contents") or []:
        if "route" in c:
            if fork is not None:
                longest = max(longest, n)
            if not c["route"]:
                n, fork = longest, None
                continue
            if fork is None:
                longest = fork = n
            n = fork
            items.append('<li class="route">%s</li>' % esc(c["route"]))
        else:
            n += 1
            hint = "<span>%s</span>" % esc(c["hint"]) if c.get("hint") else ""
            items.append('<li value="%d">%s%s</li>' % (n, esc(c["name"]), hint))
    played = n if fork is None else max(longest, n)
    return items, played if items else playable(p)


def card(p, newest):
    items, played = inside(p)
    routes = sum(1 for c in p.get("contents") or [] if c.get("route"))
    chips = []
    if not p["desk"]:
        chips.append("%d chambers" % p["chambers"])
    elif routes:
        chips.append("%d chambers per playthrough, %d in all" % (played, p["rounds"]))
    else:
        chips.append("%d chambers" % p["rounds"])
    if routes:
        chips.append("%d ways to get there" % routes)
    music = p.get("music") if p.get("music") not in (None, "", "calm") else None
    chip_html = ["<li>%s</li>" % esc(c) for c in chips]
    if music:
        chip_html.append('<li class="music">♪ %s</li>' % esc(music))
    chip_html.append("<li>%s</li>" % kb(p["bytes"]))
    if p.get("updated"):
        chip_html.append("<li>updated %s</li>" % short_date(p["updated"]))
    kind = ["A desk story" if p["desk"] else "A chamber run"]
    if p.get("author"):
        kind.append("by " + p["author"])
    media = ""
    if p.get("still"):
        flag = '<span class="flag">Newest</span>' if newest else ""
        media = ('<div class="media"><img class="still" src="%s" alt="A still from %s" width="800" height="480" '
                 'loading="lazy">%s</div>' % (esc(p["still"]), esc(p["name"]), flag))
    details = ""
    if items:
        details = ('<details class="inside"><summary>What\'s inside</summary><ol class="chambers">%s</ol></details>'
                   % "".join(items))
    return ('<article class="pack" id="%s" data-pack="%s">%s<div class="body">'
            '<p class="kind">%s</p><h2 class="name">%s</h2><p class="about">%s</p><ul class="chips">%s</ul>%s'
            '<div class="actions"><a class="zip" href="%s" download="%s.zip">Download zip</a></div>'
            '</div></article>') % (esc(p["id"]), esc(p["id"]), media, esc(" · ".join(kind)), esc(p["name"]),
                                   esc(p["about"]), "".join(chip_html), details, esc(p["zip"]), esc(p["id"]))


def ld(index):
    portals = {"@type": "VideoGame", "name": "Portals", "url": "https://annejan.com/portals/",
               "gamePlatform": "Tanmatsu (Konsool)"}
    packs = []
    for i, p in enumerate(index["packs"]):
        item = {"@type": "CreativeWork", "@id": SITE + "#" + p["id"], "name": p["name"], "description": p["about"],
                "url": SITE + "#" + p["id"], "genre": "Puzzle", "isAccessibleForFree": True, "isPartOf": portals,
                "author": {"@type": "Person", "name": p.get("author") or "annejan"},
                "encodingFormat": "application/zip", "contentUrl": SITE + p["zip"]}
        if p.get("still"):
            item["image"] = SITE + p["still"]
        if p.get("updated"):
            item["dateModified"] = p["updated"]
        packs.append({"@type": "ListItem", "position": i + 1, "item": item})
    page = {"@context": "https://schema.org", "@type": "CollectionPage", "@id": SITE, "url": SITE,
            "name": "Portals stories",
            "description": "Free story packs for Portals, the Portal-like puzzle game for the Tanmatsu (Konsool) "
                           "badge, to put on the badge from the browser over USB, or to download.",
            "inLanguage": "en", "isPartOf": {"@type": "WebSite", "name": "scene.rs", "url": "https://scene.rs/"},
            "about": portals, "mainEntity": {"@type": "ItemList", "itemListElement": packs}}
    if index.get("trailer"):
        dates = sorted(p["updated"] for p in index["packs"] if p.get("updated"))
        page["video"] = {"@type": "VideoObject", "name": "Portals stories: the trailer",
                         "description": "Chambers from the Portals stories, played on the Tanmatsu's engine.",
                         "contentUrl": SITE + index["trailer"], "thumbnailUrl": SITE + index["poster"],
                         "uploadDate": dates[-1] if dates else None}
        if not dates:
            del page["video"]["uploadDate"]
    return '<script type="application/ld+json">\n%s\n  </script>' % json.dumps(page, indent=1, ensure_ascii=False)


def share(index, out):
    """The trailer's first frame (no HUD), darkened at the bottom, with the page's name."""
    W, H = 1200, 630
    im = Image.open(os.path.join(STORIES, index["poster"])).convert("RGB")
    scale = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    left, top = (im.width - W) // 2, (im.height - H) // 2
    img = im.crop((left, top, left + W, top + H))
    shade = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(shade)
    for y in range(H):
        draw.line([(0, y), (W, y)], fill=int(60 + 180 * max(0, (y - 150) / (H - 150))))
    img = Image.composite(Image.new("RGB", (W, H), (0, 8, 30)), img, shade)
    d = ImageDraw.Draw(img)
    font = next((f for f in FONTS if os.path.exists(f)), None)
    big = ImageFont.truetype(font, 104) if font else ImageFont.load_default()
    small = ImageFont.truetype(font, 34) if font else ImageFont.load_default()
    d.rectangle([0, H - 14, W // 2, H], fill=(44, 140, 255))
    d.rectangle([W // 2, H - 14, W, H], fill=(255, 138, 28))
    d.text((56, H - 250), "Portals stories", font=big, fill=(255, 255, 255))
    chambers = sum(playable(p) for p in index["packs"])
    d.text((60, H - 120), "%d stories · %d chambers · for the Tanmatsu, over USB" % (len(index["packs"]), chambers),
           font=small, fill=(219, 230, 255))
    img.save(out, quality=86, optimize=True, progressive=True)


def between(text, name, body):
    pat = re.compile(r"(<!-- %s[^>]*-->)(.*?)(<!-- /%s -->)" % (name, name), re.S)
    if not pat.search(text):
        raise SystemExit("stories/index.html: no <!-- %s --> markers" % name)
    return pat.sub(lambda m: m.group(1) + body + m.group(3), text, count=1)


def main():
    index = json.load(open(os.path.join(STORIES, "index.json")))
    page = os.path.join(STORIES, "index.html")
    text = open(page).read()
    cards = "\n      ".join(card(p, i == 0 and len(index["packs"]) > 1) for i, p in enumerate(index["packs"]))
    text = between(text, "packs", "\n      " + cards + "\n      ")
    text = between(text, "ld", "\n  " + ld(index) + "\n  ")
    chambers = sum(playable(p) for p in index["packs"])
    text = between(text, "stats", "%d stories · %d chambers · free to play" % (len(index["packs"]), chambers))
    open(page, "w").write(text)
    share(index, os.path.join(STORIES, "share.jpg"))
    print("%d packs: stories/index.html, stories/share.jpg" % len(index["packs"]))


if __name__ == "__main__":
    main()
