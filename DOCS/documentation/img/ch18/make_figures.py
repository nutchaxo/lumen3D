#!/usr/bin/env python3
"""Figures of chapter 18 (hosting, updating, releasing).

    FIG_LANG=fr python make_figures.py          # French (default)
    FIG_LANG=en IMG_DIR=../../img-en/ch18 python make_figures.py

Every text goes through T(fr, en); nothing else varies between languages.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from svglib import Svg, T, ACC, INK, INK2, LINE, WARN, LANG


def ok_no(s, x, y, w, h, yes, text=None):
    if yes is True:
        s.pill(x, y, w, h, text or T("oui", "yes"), "green")
    elif yes is False:
        s.pill(x, y, w, h, text or T("non", "no"), "grey", weight=600)
    else:
        s.pill(x, y, w, h, text, "amber", size=11)


# ---------------------------------------------------------------- 1
def trois_serveurs():
    s = Svg("trois-serveurs", 500, T("Qui sait faire quoi : les façons de servir Lumen3D",
                                     "Who can do what: the ways to serve Lumen3D"))
    cols = [("dev_server.py", "Python", "blue"), ("fast_server.py", T("Python, lecture", "Python, read-only"), "teal"),
            (T("api/*.php", "api/*.php"), "PHP + Apache", "violet"), (T("Hôte statique", "Static host"), T("fichiers seuls", "files only"), "grey")]
    x0, cw, step = 232, 132, 137
    for i, (a, b, acc) in enumerate(cols):
        x = x0 + i * step
        strong, soft = ACC[acc]
        s.rect(x, 56, cw, 56, soft, strong, rx=10)
        s.text(x + cw / 2, 79, a, 13, 800, strong, anchor="middle", maxw=cw - 8)
        s.text(x + cw / 2, 98, b, 11.5, 400, INK2, anchor="middle", maxw=cw - 8)
    rows = [
        (T("Distribue les fichiers", "Serves the files"), [True, True, True, True]),
        (T("Nonce + CSP sur les pages HTML", "Nonce + CSP on HTML pages"), [True, True, True, False]),
        (T("Catalogue des jeux (à la demande)", "Dataset catalogue (on demand)"), [True, True, True, False]),
        (T("API d'administration", "Administration API"), [True, False, True, False]),
        (T("Import par le navigateur", "Browser import"), [True, False, True, False]),
        (T("Mise à jour de la plateforme", "Platform update"),
         [T("avec retour arrière", "with rollback"), False, T("sans retour arrière", "no rollback"), False]),
        (T("Sonde /api/health", "/api/health probe"), [True, True, False, False]),
    ]
    y = 124
    for lab, vals in rows:
        s.text(24, y + 26, lab, 13, 600, INK, maxw=200)
        for i, v in enumerate(vals):
            x = x0 + i * step
            if isinstance(v, str):
                ok_no(s, x + 6, y + 8, cw - 12, 28, None, v)
            else:
                ok_no(s, x + 28, y + 8, cw - 56, 28, v)
        s.line(24, y + 48, 776, y + 48, LINE, 1)
        y += 52
    s.save()


# ---------------------------------------------------------------- 2
def chemin_requete():
    s = Svg("chemin-requete", 640, T("Où va une requête GET (serveur Python) ?", "Where does a GET request go (Python server)?"))
    s.defs = None
    rows = [
        (T("1 · Le catalogue", "1 · The catalogue"), "/DATA_WEB/catalog.json",
         T("Construit à la demande", "Built on demand"), T("liste relue, ETag, gzip", "list re-read, ETag, gzip"), "teal"),
        (T("2 · Les sondes publiques", "2 · Public probes"), "/api/health  /api/plugins  /api/languages",
         T("Réponses JSON publiques", "Public JSON answers"), "Cache-Control: no-store", "grey"),
        (T("3 · Les gestionnaires d'API", "3 · API handlers"), "/api/auth.php  datasets  admin  upload …",
         T("Code d'administration", "Administration code"), T("session, CSRF, limites de débit", "session, CSRF, rate limits"), "amber"),
        (T("4 · Les chemins interdits", "4 · Forbidden paths"), "api/  uploads/  logs/  secrets/  .git  .xxx",
         T("Réponse 404", "404 answer"), T("même pour un fichier qui existe", "even for a file that exists"), "red"),
        (T("5 · Les pages HTML", "5 · HTML pages"), "/  viewer.html  admpan.html …",
         T("Nonce neuf + CSP appliquée", "Fresh nonce + CSP enforced"), "Cache-Control: no-store", "violet"),
        (T("6 · Tout le reste", "6 · Everything else"), T("scripts, styles, briques, images…", "scripts, styles, bricks, images…"),
         T("Fichier statique", "Static file"), "ETag/304 · gzip · Range", "green"),
    ]
    y = 62
    for i, (a, path, b, c, acc) in enumerate(rows):
        strong, soft = ACC[acc]
        s.rect(26, y, 340, 62, "#fff", LINE)
        s.text(40, y + 24, a, 14, 800, strong, maxw=316)
        s.text(40, y + 46, path, 11.5, 400, INK2, maxw=316, mono=True)
        s.line(368, y + 31, 424, y + 31, INK2, 2.2, arrow=True)
        s.rect(430, y, 344, 62, soft, strong, rx=10)
        s.text(446, y + 26, b, 14, 700, INK, maxw=316)
        s.text(446, y + 47, c, 12, 400, INK2, maxw=316)
        if i < len(rows) - 1:
            s.line(196, y + 62, 196, y + 94, INK2, 2.2, arrow=True)
            s.text(206, y + 83, T("sinon", "otherwise"), 11.5, 400, INK2)
        y += 96
    s.save()


# ---------------------------------------------------------------- 3
def hebergement():
    s = Svg("hebergement", 440, T("Quel hébergement choisir ?", "Which hosting to choose?"))
    s.card(250, 54, 300, 44, [T("Que propose votre hébergeur ?", "What does your host offer?")], "blue", 14, 800)
    cols = [
        (T("Python 3.10 ou plus", "Python 3.10 or newer"), T("poste du labo, VM, serveur dédié", "lab PC, VM, dedicated server"),
         "python dev_server.py", [T("tout est inclus", "everything included"), T("mise à jour avec retour", "update with rollback"),
                                    T("rien à installer", "nothing to install")], "blue", 24),
        (T("PHP 8.1 + Apache", "PHP 8.1 + Apache"), T("mutualisé d'université", "shared university hosting"),
         ".htaccess + _serve.php", [T("même administration", "same administration"), T("mise à jour sans retour", "update without rollback"),
                                    T("php -S pour tester", "php -S to test")], "violet", 284),
        (T("Fichiers seulement", "Files only"), T("stockage statique, GitHub Pages…", "static storage, GitHub Pages…"),
         T("aucun programme", "no program"), [T("pas d'administration", "no administration"), T("pas de catalogue généré", "no generated catalogue"),
                                              T("pas de CSP à nonce", "no nonce CSP")], "grey", 544),
    ]
    for t1, t2, cmd, pts, acc, x in cols:
        strong, soft = ACC[acc]
        s.path(f"M400,98 V116 H{x+116} V132", INK2, 2)
        s.rect(x, 134, 232, 250, "#fff", LINE)
        s.p.append(f'<path d="M{x},{x*0+168} V146 a12,12 0 0 1 12,-12 H{x+220} a12,12 0 0 1 12,12 V168 Z" fill="{soft}"/>')
        s.text(x + 116, 158, t1, 14, 800, strong, anchor="middle", maxw=216)
        s.text(x + 116, 192, t2, 11.5, 400, INK2, anchor="middle", maxw=216)
        s.rect(x + 14, 206, 204, 30, soft, strong, rx=8)
        s.text(x + 116, 226, cmd, 12.5, 700, strong, anchor="middle", maxw=196, mono=True)
        yy = 266
        for p in pts:
            s.text(x + 16, yy, "•", 14, 800, strong)
            s.text(x + 30, yy, p, 12, 400, INK, maxw=194)
            yy += 38
    s.text(400, 414, T("fast_server.py : mêmes réponses publiques que dev_server.py, sans administration — pour mesurer les performances.",
                       "fast_server.py: same public answers as dev_server.py, no administration — for performance measurements."),
           11.5, 400, INK2, anchor="middle", maxw=760)
    s.save()


# ---------------------------------------------------------------- 4
def cache():
    s = Svg("cache", 520, T("Le tableau de décision du cache HTTP", "The HTTP cache decision table"))
    xs = [24, 262, 520]
    ws = [228, 248, 256]
    heads = [(T("Quel fichier ?", "Which file?"), "grey"), (T("URL avec ?v=…", "URL with ?v=…"), "green"),
             (T("URL sans ?v=", "URL without ?v="), "amber")]
    for x, w, (h, acc) in zip(xs, ws, heads):
        strong, soft = ACC[acc]
        s.rect(x, 52, w, 36, soft, strong, rx=8)
        s.text(x + w / 2, 75, h, 13.5, 800, strong, anchor="middle", maxw=w - 8)
    imm_y = T("immuable, 1 an", "immutable, 1 year")
    imm_w = T("immuable, 7 jours", "immutable, 7 days")
    nc = "no-cache + ETag"
    rows = [
        (T("Page HTML", "HTML page"), "no-store", "red", "no-store", "red", T("(nonce neuf à chaque fois)", "(fresh nonce every time)")),
        (T("Paquet de briques", "Brick pack"), imm_y, "green", nc, "amber", ".bin  .rgba  .gz"),
        (T("Script, style", "Script, style"), imm_w, "green", nc, "amber", ".js  .mjs  .css"),
        (T("JSON, manifeste, catalogue", "JSON, manifest, catalogue"), nc, "amber", nc, "amber", T("le ?v= ne change rien", "?v= changes nothing")),
        (T("Réponses de l'API", "API answers"), "no-store", "red", "no-store", "red", "/api/…"),
    ]
    y = 98
    for lab, a, ca, b, cb, note in rows:
        s.rect(24, y, 752, 62, "#fff", LINE, rx=10)
        s.text(38, y + 26, lab, 13.5, 700, INK, maxw=216)
        s.text(38, y + 47, note, 11.5, 400, INK2, maxw=216, mono=note.startswith(".") or note.startswith("/"))
        s.pill(xs[1] + 12, y + 16, ws[1] - 24, 30, a, ca, 12.5)
        s.pill(xs[2] + 12, y + 16, ws[2] - 24, 30, b, cb, 12.5)
        y += 70
    s.text(400, y + 18, T("no-cache = le navigateur garde le fichier mais le redemande : le serveur répond « 304, inchangé » sans renvoyer les octets.",
                          "no-cache = the browser keeps the file but asks again: the server answers “304, unchanged” without resending the bytes."),
           11.5, 400, INK2, anchor="middle", maxw=770)
    s.text(400, y + 40, T("Images, polices : no-cache + ETag sur le serveur Python ; 7 jours sur Apache (.htaccess).",
                          "Images, fonts: no-cache + ETag on the Python server; 7 days on Apache (.htaccess)."),
           11.5, 400, INK2, anchor="middle", maxw=770)
    s.save()


# ---------------------------------------------------------------- 5
def chargement():
    s = Svg("chargement", 500, T("Ce que le navigateur redemande, d'une visite à l'autre", "What the browser asks again, visit after visit"))
    xs = [24, 330, 560]
    s.text(xs[1] + 100, 66, T("1re visite", "1st visit"), 14, 800, ACC["blue"][0], anchor="middle")
    s.text(xs[2] + 108, 66, T("visites suivantes", "later visits"), 14, 800, ACC["green"][0], anchor="middle")
    rows = [
        ("viewer.html", T("page, nonce neuf", "page, fresh nonce"), (T("200 + octets", "200 + bytes"), "blue"), (T("200 + octets", "200 + bytes"), "blue")),
        (T("scripts ?v=1.59.3", "scripts ?v=1.59.3"), T("~25 fichiers", "~25 files"), (T("200, gzip", "200, gzip"), "blue"), (T("cache : 0 requête", "cache: 0 request"), "green")),
        ("bricks/manifest.json", T("plan du jeu", "dataset plan"), (T("200, gzip", "200, gzip"), "blue"), (T("304 : 0 octet", "304: 0 bytes"), "amber")),
        ("DATA_WEB/catalog.json", T("liste des jeux", "list of datasets"), (T("200, gzip", "200, gzip"), "blue"), (T("304 : 0 octet", "304: 0 bytes"), "amber")),
        (T("paquets ?v=<empreinte>", "packs ?v=<hash>"), T("les briques", "the bricks"), (T("200, Mo", "200, MB"), "blue"), (T("cache : 0 requête", "cache: 0 request"), "green")),
    ]
    y = 80
    for a, b, (c1, a1), (c2, a2) in rows:
        s.rect(24, y, 752, 66, "#fff", LINE, rx=10)
        s.text(38, y + 28, a, 13, 700, INK, maxw=270, mono=True)
        s.text(38, y + 50, b, 11.5, 400, INK2, maxw=270)
        s.pill(xs[1] + 4, y + 18, 196, 30, c1, a1, 12.5)
        s.pill(xs[2] + 4, y + 18, 208, 30, c2, a2, 12.5)
        s.line(xs[1] + 202, y + 33, xs[2] + 2, y + 33, INK2, 1.6, arrow=True)
        y += 76
    s.text(400, y + 14, T("Le ?v= d'un paquet est une empreinte de la liste des paquets : retraiter un jeu change les adresses, jamais d'anciennes briques.",
                          "A pack's ?v= is a hash of the pack list: reprocessing a dataset changes the addresses, never serves old bricks."),
           11.5, 400, INK2, anchor="middle", maxw=770)
    s.save()


# ---------------------------------------------------------------- 6
def ranges():
    s = Svg("ranges", 470, T("Demander seulement un morceau d'un fichier : les plages d'octets",
                             "Asking for just a slice of a file: byte ranges"))
    s.text(24, 72, T("Un paquet de 1 383 748 octets sur le disque du serveur", "A 1,383,748-byte pack on the server's disk"), 13, 700, INK)
    s.rect(24, 84, 752, 34, "#fff", LINE, rx=8)
    s.rect(24, 84, 40, 34, ACC["blue"][1], ACC["blue"][0], rx=4)
    s.rect(300, 84, 40, 34, ACC["amber"][1], ACC["amber"][0], rx=4)
    s.text(44, 106, "A", 14, 800, ACC["blue"][0], anchor="middle")
    s.text(320, 106, "B", 14, 800, ACC["amber"][0], anchor="middle")
    s.text(24, 136, "0", 11, 400, INK2); s.text(776, 136, T("fin", "end"), 11, 400, INK2, anchor="end")
    cards = [
        ("Range: bytes=0-99", T("une plage", "one range"), "206 + Content-Range", T("seuls les octets de A, rien d'autre", "only A's bytes, nothing else"), "blue"),
        ("Range: bytes=0-99, 500-599", T("deux plages", "two ranges"), "206 multipart/byteranges", T("A et B dans une seule réponse (un aller-retour)", "A and B in one answer (one round trip)"), "teal"),
        ("Range: bytes=99999999-", T("hors du fichier", "outside the file"), "416 bytes */1383748", T("« insatisfaisable » : aucun octet", "“unsatisfiable”: no byte"), "red"),
        (T("plage mal formée, ou plus de 64 plages", "malformed range, or more than 64"), T("cas limite", "edge case"), "200", T("tout le fichier : toujours permis par la norme", "the whole file: always allowed by the standard"), "grey"),
    ]
    y = 156
    for hdr, nm, code, desc, acc in cards:
        strong, soft = ACC[acc]
        s.rect(24, y, 752, 68, "#fff", LINE, rx=10)
        s.rect(24, y, 6, 68, strong, strong, rx=3)
        s.text(44, y + 26, hdr, 13, 700, INK, maxw=380, mono=hdr.startswith("Range"))
        s.text(44, y + 50, nm, 12, 400, INK2, maxw=380)
        s.pill(420, y + 10, 200, 26, code, acc, 11.5)
        s.text(420, y + 56, desc, 11.5, 400, INK2, maxw=350)
        y += 76
    s.save()


# ---------------------------------------------------------------- 7
def dossiers():
    s = Svg("dossiers", 560, T("Les dossiers du site : lesquels sont servis, lesquels jamais", "The site's folders: which are served, which never"))
    rows = [
        ("api/", T("*.json (mot de passe, stats…) et _*.php", "*.json (password, stats…) and _*.php"), T("fermé", "closed"), "red"),
        ("uploads/", T("imports non validés : 4 verrous", "unvalidated imports: 4 locks"), T("fermé", "closed"), "red"),
        ("secrets/  logs/  backups/", T("graines de signature, journaux, copies", "signing seeds, logs, copies"), T("fermé", "closed"), "red"),
        (".git  .htaccess  .xxx", T("tout nom commençant par un point", "any name starting with a dot"), T("fermé", "closed"), "red"),
        ("*.lumen-old|new|backup", T("fichiers parqués par une mise à jour", "files parked by an update"), T("fermé", "closed"), "red"),
        ("DATA_WEB/", T("exécution interdite ; download/ en pièce jointe", "execution banned; download/ as attachment"), T("sans exécution", "no execution"), "amber"),
        ("js/", T("exécution interdite (les plugins y atterrissent)", "execution banned (plugins land there)"), T("sans exécution", "no execution"), "amber"),
        ("config/", T("public ; protégé des mises à jour", "public; protected from updates"), T("servi", "served"), "green"),
    ]
    y = 56
    for name, rule, chip, acc in rows:
        s.rect(24, y, 752, 58, "#fff", LINE, rx=10)
        s.text(40, y + 36, name, 13.5, 800, ACC[acc][0], maxw=210, mono=True)
        s.text(262, y + 35, rule, 12, 400, INK, maxw=360)
        s.pill(636, y + 15, 126, 28, chip, acc, 11.5)
        y += 62
    s.save()


# ---------------------------------------------------------------- 8
def proxy():
    s = Svg("proxy", 400, T("Derrière un proxy inverse : quelle adresse est « le visiteur » ?", "Behind a reverse proxy: which address is “the visitor”?"))
    s.card(24, 70, 170, 74, [T("Visiteur", "Visitor"), "203.0.113.7"], "blue")
    s.card(318, 70, 170, 74, [T("Proxy inverse", "Reverse proxy"), "10.0.0.2"], "violet")
    s.card(606, 70, 170, 74, ["Lumen3D", T("voit 10.0.0.2", "sees 10.0.0.2")], "green")
    s.line(196, 107, 316, 107, INK2, 2.2, arrow=True)
    s.line(490, 107, 604, 107, INK2, 2.2, arrow=True)
    s.text(500, 168, "X-Forwarded-For: 203.0.113.7", 12, 600, INK2, anchor="middle", mono=True)
    s.rect(24, 196, 368, 176, ACC["red"][1], ACC["red"][0])
    s.text(40, 224, T("Proxy non déclaré", "Undeclared proxy"), 14, 800, ACC["red"][0], maxw=340)
    for i, ln in enumerate([T("Tous les visiteurs ont l'adresse 10.0.0.2.", "All visitors have address 10.0.0.2."),
                            T("Un seul compteur d'échecs de connexion :", "A single login-failure counter:"),
                            T("dix essais ratés par quelqu'un bloquent", "ten failed tries by someone lock out"),
                            T("tout le monde pendant 15 minutes.", "everybody for 15 minutes.")]):
        s.text(40, 252 + i * 22, ln, 12.5, 400, INK, maxw=340)
    s.rect(408, 196, 368, 176, ACC["green"][1], ACC["green"][0])
    s.text(424, 224, T("Proxy déclaré (--trusted-proxy 10.0.0.2)", "Declared proxy (--trusted-proxy 10.0.0.2)"), 13.5, 800, ACC["green"][0], maxw=340)
    for i, ln in enumerate([T("Chaque proxy AJOUTE l'adresse qu'il voit.", "Each proxy APPENDS the address it sees."),
                            T("On lit la liste à partir de la droite et on", "The list is read from the right and the"),
                            T("garde le premier saut non déclaré :", "first undeclared hop is kept:"),
                            "1.2.3.4, 203.0.113.7  →  203.0.113.7",
                            T("(1.2.3.4 a été écrit par le visiteur : ignoré)", "(1.2.3.4 was written by the visitor: ignored)")]):
        s.text(424, 250 + i * 22, ln, 12.5, 400, INK, maxw=344, mono=(i == 3))
    s.save()


# ---------------------------------------------------------------- 9
def maj_chaine():
    s = Svg("maj-chaine", 470, T("Mettre à jour (serveur Python) : huit étapes, une seule qui modifie le site",
                                  "Updating (Python server): eight steps, only one changes the site"))
    st = [
        ("1", T("Vérifications", "Checks"), [T("même volume,", "same volume,"), T("espace disque", "disk space")], 3),
        ("2", T("Sauvegarde", "Backup"), [T("zip de l'installation,", "zip of the install,"), T("relu après écriture", "re-read after writing")], 8),
        ("3", T("Téléchargement", "Download"), [T("taille annoncée", "announced size"), T("vérifiée", "checked")], 15),
        ("4", T("Authenticité", "Authenticity"), [T("signature Ed25519", "Ed25519 signature"), T("puis SHA-256", "then SHA-256")], 55),
        ("5", T("Préparation", "Staging"), [T("extraction sûre", "safe extraction"), T("dans un dossier à part", "into a separate folder")], 65),
        ("6", T("Démarrage à blanc", "Dry run"), ["dev_server.py --check", T("sur l'arbre neuf", "on the new tree")], 78),
        ("7", T("Plan + journal", "Plan + journal"), [T("fichiers à poser", "files to place"), T("et à retirer", "and to remove")], 85),
        ("8", T("Basculement", "Switch"), [T("superviseur", "supervisor"), T("détaché", "detached")], 90),
    ]
    for i, (n, a, ls, pct) in enumerate(st):
        r, c = divmod(i, 4)
        x, y = 24 + c * 190, 64 + r * 150
        acc = "red" if i == 7 else "blue"
        strong, soft = ACC[acc]
        s.rect(x, y, 172, 116, "#fff", LINE)
        s.p.append(f'<path d="M{x},{y+32} V{y+12} a12,12 0 0 1 12,-12 H{x+160} a12,12 0 0 1 12,12 V{y+32} Z" fill="{soft}"/>')
        s.text(x + 12, y + 22, f"{n} · {a}", 13.5, 800, strong, maxw=150)
        for j, ln in enumerate(ls):
            s.text(x + 12, y + 56 + j * 20, ln, 12, 400, INK2, maxw=150, mono=ln.startswith("dev_"))
        s.text(x + 12, y + 104, f"{pct} %", 11, 600, strong)
        if c < 3:
            s.line(x + 174, y + 58, x + 188, y + 58, INK2, 2, arrow=True)
    s.path("M780,180 V196 H20 V212 H24", INK2, 2, arrow=True)
    s.text(776, 56, T("% = avancement affiché dans l'admin", "% = progress shown in the admin"), 11, 400, INK2, anchor="end")
    s.rect(24, 342, 520, 96, ACC["green"][1], ACC["green"][0])
    s.text(40, 368, T("Étapes 1 à 7 : l'installation n'est pas touchée", "Steps 1 to 7: the installation is not touched"), 14, 800, ACC["green"][0], maxw=490)
    s.text(40, 392, T("Une erreur à n'importe quel point abandonne la mise à jour.", "An error at any point abandons the update."), 12.5, 400, INK, maxw=490)
    s.text(40, 414, T("Message : « installation intacte ». Rien n'a été remplacé.", "Message: “installation intact”. Nothing was replaced."), 12.5, 400, INK, maxw=490)
    s.rect(560, 342, 216, 96, ACC["red"][1], ACC["red"][0])
    s.text(574, 368, T("Étape 8", "Step 8"), 14, 800, ACC["red"][0])
    s.text(574, 392, T("seule phase qui modifie", "the only phase that changes"), 12.5, 400, INK, maxw=190)
    s.text(574, 414, T("le site (figure suivante)", "the site (next figure)"), 12.5, 400, INK, maxw=190)
    s.save()


# ---------------------------------------------------------------- 10
def pivot():
    s = Svg("pivot", 600, T("Le basculement : un superviseur, une sonde, un retour arrière", "The switch: a supervisor, a probe, a rollback"))
    top = [
        (T("Arrêt propre", "Clean stop"), [T("le serveur actuel", "the current server"), T("cesse d'écouter", "stops listening")], "blue"),
        (T("Port libre ?", "Port free?"), [T("le superviseur", "the supervisor"), T("attend ≤ 30 s", "waits ≤ 30 s")], "blue"),
        (T("Échange", "Swap"), [T("renommages", "renames"), T("journalisés", "journalled")], "amber"),
        (T("Démarrage", "Start"), [T("le serveur neuf", "the new server"), T("est lancé", "is launched")], "violet"),
        (T("Sonde de santé", "Health probe"), ["/api/health", T("≤ 30 s", "≤ 30 s")], "teal"),
    ]
    for i, (a, ls, acc) in enumerate(top):
        x = 12 + i * 156
        strong, soft = ACC[acc]
        s.rect(x, 56, 140, 100, "#fff", LINE)
        s.p.append(f'<path d="M{x},{56+30} V{56+12} a12,12 0 0 1 12,-12 H{x+128} a12,12 0 0 1 12,12 V{56+30} Z" fill="{soft}"/>')
        s.text(x + 70, 77, f"{i+1} · {a}", 12.5, 800, strong, anchor="middle", maxw=130)
        for j, ln in enumerate(ls):
            s.text(x + 70, 108 + j * 20, ln, 12, 400, INK2, anchor="middle", maxw=130, mono=ln.startswith("/"))
        if i < 4:
            s.line(x + 142, 106, x + 154, 106, INK2, 2, arrow=True)
    # branches
    s.path("M742,158 V216", ACC["green"][0], 2.4)
    s.text(750, 190, T("répond", "answers"), 11.5, 700, ACC["green"][0])
    s.path("M690,158 V190 H205 V214", ACC["red"][0], 2.4)
    s.text(450, 184, T("aucune réponse en 30 s, ou mauvaise version", "no answer in 30 s, or wrong version"), 11.5, 700, ACC["red"][0], anchor="middle", maxw=380)
    s.rect(400, 216, 380, 100, ACC["green"][1], ACC["green"][0])
    s.text(416, 242, T("Réussi", "Success"), 14, 800, ACC["green"][0])
    for j, ln in enumerate([T("le journal est effacé, le dossier de préparation purgé,", "the journal is erased, the staging folder purged,"),
                            T("le résultat est mémorisé pour le panneau d'admin.", "the result is remembered for the admin panel.")]):
        s.text(416, 266 + j * 22, ln, 12, 400, INK, maxw=355)
    s.rect(20, 216, 370, 150, ACC["red"][1], ACC["red"][0])
    s.text(36, 242, T("Retour arrière automatique", "Automatic rollback"), 14, 800, ACC["red"][0])
    for j, ln in enumerate([T("1. arrêt du serveur neuf, attente du port", "1. stop the new server, wait for the port"),
                            T("2. journal marqué « rolling_back » AVANT d'agir", "2. journal marked “rolling_back” BEFORE acting"),
                            T("3. renommages inverses (l'ancien arbre revient)", "3. reverse renames (the old tree comes back)"),
                            T("4. ancien serveur relancé, sonde de confirmation", "4. old server restarted, confirmation probe"),
                            T("5. résultat « rolled_back » visible dans l'admin", "5. “rolled_back” result shown in the admin")]):
        s.text(36, 268 + j * 20, ln, 12, 400, INK, maxw=345)
    # reconcile
    s.rect(20, 392, 760, 186, "#fff", ACC["grey"][0], dash="6 5")
    s.text(36, 418, T("Et si le superviseur lui-même meurt (coupure de courant) ?", "And if the supervisor itself dies (power cut)?"), 14, 800, INK)
    s.text(36, 444, T("Au prochain démarrage, le serveur trouve le journal et décide :", "At the next start the server finds the journal and decides:"), 12.5, 400, INK2, maxw=730)
    s.card(36, 460, 350, 96, [T("Aller de l'avant seulement si…", "Go forward only if…"), T("phase « applied » ou « done », version = cible", "phase “applied” or “done”, version = target"),
                              T("ET chaque fichier a le bon SHA-256", "AND every file has the right SHA-256")], "green", 12, 700, "start")
    s.card(406, 460, 358, 96, [T("Dans tout autre cas : retour arrière", "In every other case: roll back"), T("(y compris un retour arrière interrompu :", "(including an interrupted rollback:"),
                              T("on ne se fie jamais à la seule version)", "never trust the version alone)")], "red", 12, 700, "start")
    s.save()


# ---------------------------------------------------------------- 11
def deux_maj():
    s = Svg("deux-mises-a-jour", 520, T("Deux façons de se mettre à jour, selon le serveur", "Two ways to update, depending on the server"))
    s.card(212, 54, 270, 40, ["Python — dev_server.py"], "blue", 14, 800)
    s.card(494, 54, 282, 40, [T("PHP — api/_admin_lib.php", "PHP — api/_admin_lib.php")], "violet", 14, 800)
    rows = [
        (T("Déroulement", "Flow"), T("tâche de fond + superviseur", "background task + supervisor"), T("une seule requête, synchrone", "a single synchronous request")),
        (T("Sauvegarde zip", "Zip backup"), T("oui (3 conservées)", "yes (3 kept)"), T("non", "no")),
        (T("Démarrage à blanc", "Dry run"), "--check", T("non", "no")),
        (T("Échange des fichiers", "File swap"), T("renommages journalisés", "journalled renames"), T("ancien fichier parqué, puis nouveau posé", "old file parked, then new one placed")),
        (T("Redémarrage + sonde", "Restart + probe"), T("oui, /api/health", "yes, /api/health"), T("sans objet : PHP repart à chaque requête", "n/a: PHP starts afresh every request")),
        (T("Retour arrière", "Rollback"), T("automatique", "automatic"), T("aucun : on relance (idempotent)", "none: just run again (idempotent)")),
        (T("Fichiers supprimés", "Removed files"), T("différence des version.json", "diff of the version.json files"), T("liste fixe (api/config.php)", "fixed list (api/config.php)")),
        (T("Signature + SHA-256", "Signature + SHA-256"), T("identiques, fail-closed", "identical, fail-closed"), T("identiques, fail-closed", "identical, fail-closed")),
    ]
    y = 106
    for lab, a, b in rows:
        s.rect(24, y, 752, 46, "#fff", LINE, rx=8)
        s.text(38, y + 28, lab, 12.5, 700, INK, maxw=170)
        s.text(224, y + 28, a, 12, 400, INK2, maxw=256)
        s.text(506, y + 28, b, 12, 400, INK2, maxw=262)
        y += 50
    s.save()


# ---------------------------------------------------------------- 12
def protege():
    s = Svg("protege", 520, T("Ce qu'une mise à jour touche, et ce qu'elle ne touche jamais", "What an update touches, and what it never touches"))
    s.rect(24, 54, 360, 440, ACC["red"][1], ACC["red"][0])
    s.text(40, 82, T("Jamais touché", "Never touched"), 15, 800, ACC["red"][0])
    never = [
        ("DATA_WEB/", T("vos jeux de données", "your datasets")),
        ("uploads/", T("imports en cours", "imports in progress")),
        ("logs/  backups/  secrets/", T("journaux, copies, graines", "logs, copies, seeds")),
        ("api/admin_credential.json", T("votre mot de passe (empreinte)", "your password (hash)")),
        ("api/stats.json", T("les compteurs d'usage", "the usage counters")),
        ("api/plugin-trust.json …", T("approbations, plugins désactivés", "approvals, disabled plugins")),
        ("api/marketplace-state.json", T("numéro de série anti-retour", "anti-rollback serial")),
        ("config/instance.json  theme  legal  pages/", T("votre personnalisation", "your customisation")),
        ("api/page-drafts/", T("brouillons non publiés", "unpublished drafts")),
        ("install.php", T("l'installeur reste verrouillé", "the installer stays locked")),
    ]
    y = 100
    for a, b in never:
        s.text(40, y, a, 11.5, 700, INK, maxw=336, mono=True)
        s.text(40, y + 16, b, 11.5, 400, INK2, maxw=336)
        y += 38
    s.rect(400, 54, 376, 440, ACC["green"][1], ACC["green"][0])
    s.text(416, 82, T("Remplacé par la nouvelle version", "Replaced by the new version"), 15, 800, ACC["green"][0], maxw=350)
    repl = [
        (T("Pages HTML", "HTML pages"), "index, viewer, compare, 2d, admpan …"),
        ("js/ css/ lang/", T("code, styles, traductions", "code, styles, translations")),
        ("api/*.php", T("le code PHP du serveur", "the server's PHP code")),
        ("dev_server.py …", T("serveur Python et moteurs", "Python server and engines")),
        ("changelog/", T("notes de version (la version = le plus récent)", "release notes (the version = the newest)")),
        (".htaccess", T("bloc LUMEN3D réécrit, vos lignes gardées", "LUMEN3D block rewritten, your lines kept")),
        ("config/defaults/", T("modèles neutres", "neutral templates")),
    ]
    y = 100
    for a, b in repl:
        s.text(416, y, a, 11.5, 700, INK, maxw=350, mono=a.startswith(("js", "api", "dev", "chan", ".ht", "conf")))
        s.text(416, y + 16, b, 11.5, 400, INK2, maxw=350)
        y += 38
    s.text(416, y + 12, T("Le code d'un plugin installé (js/modules/) n'est pas", "An installed plugin's code (js/modules/) is not"), 11.5, 400, INK2, maxw=350)
    s.text(416, y + 30, T("dans la version : il n'est donc jamais écrasé.", "in the release: it is therefore never overwritten."), 11.5, 400, INK2, maxw=350)
    s.save()


# ---------------------------------------------------------------- 13
def signatures():
    s = Svg("signatures", 560, T("La chaîne de signature d'une version", "A release's signature chain"))
    s.text(24, 66, T("1 · Chez l'éditeur (CI GitHub)", "1 · At the publisher (GitHub CI)"), 14, 800, ACC["blue"][0])
    s.card(24, 78, 224, 84, ["SHA256SUMS", T("une ligne par fichier publié :", "one line per published file:"), T("zip, packs, notes", "zip, packs, notes")], "amber")
    s.card(288, 78, 224, 84, [T("Signature Ed25519", "Ed25519 signature"), T("graine privée = secret GitHub", "private seed = GitHub secret"), "LUMEN_SIGNING_KEY"], "blue")
    s.card(552, 78, 224, 84, ["SHA256SUMS.sig", T("128 caractères hexadécimaux", "128 hexadecimal characters")], "violet")
    s.line(250, 120, 286, 120, INK2, 2.2, arrow=True)
    s.line(514, 120, 550, 120, INK2, 2.2, arrow=True)
    s.text(400, 196, T("▼  publiés ensemble avec le zip, comme éléments de la version GitHub  ▼", "▼  published together with the zip, as assets of the GitHub release  ▼"), 12.5, 700, INK2, anchor="middle", maxw=760)
    s.text(24, 232, T("2 · Chez vous (serveur Python, serveur PHP ou installeur)", "2 · At your site (Python server, PHP server or installer)"), 14, 800, ACC["green"][0])
    boxes = [(T("Clé publique épinglée", "Pinned public key"), [T("écrite dans le code,", "written in the code,"), T("en trois exemplaires", "in three copies")]),
             (T("Signature valide ?", "Signature valid?"), [T("calculée sur les octets", "computed over the exact"), T("exacts de SHA256SUMS", "bytes of SHA256SUMS")]),
             (T("Zip listé ?", "Zip listed?"), [T("SHA-256 recalculé =", "recomputed SHA-256 ="), T("ligne de SHA256SUMS", "SHA256SUMS line")]),
             (T("Extraction", "Extraction"), [T("seulement après les", "only after the"), T("deux contrôles", "two checks")])]
    for i, (a, ls) in enumerate(boxes):
        x = 24 + i * 190
        s.card(x, 246, 172, 86, [a] + ls, "green", 12.5)
        if i < 3:
            s.line(x + 174, 289, x + 188, 289, INK2, 2.2, arrow=True)
    s.rect(24, 356, 752, 186, ACC["red"][1], ACC["red"][0])
    s.text(40, 384, T("Refusé sans appel (fail-closed) : la mise à jour s'arrête", "Refused outright (fail-closed): the update stops"), 14, 800, ACC["red"][0], maxw=720)
    refus = [T("• pas de SHA256SUMS dans la version, ou archive absente de la liste", "• no SHA256SUMS in the release, or archive missing from the list"),
             T("• pas de SHA256SUMS.sig alors qu'une clé est épinglée", "• no SHA256SUMS.sig although a key is pinned"),
             T("• signature illisible ou invalide pour la clé épinglée", "• unreadable signature, or invalid for the pinned key"),
             T("• empreinte du zip différente de celle de la liste", "• zip digest different from the listed one"),
             T("• plusieurs archives du même nom, ou nom ≠ lumen3d-web-<version>.zip", "• several archives of that name, or name ≠ lumen3d-web-<version>.zip"),
             T("• jamais le zip « source » automatique de GitHub (non listé)", "• never GitHub's automatic “source” zip (not listed)")]
    for i, r in enumerate(refus):
        s.text(40, 410 + i * 22, r, 12.5, 400, INK, maxw=720)
    s.save()


# ---------------------------------------------------------------- 14
def release_pipeline():
    s = Svg("release-pipeline", 560, T("Du changelog à votre serveur : la chaîne de publication", "From the changelog to your server: the release chain"))
    top = [
        (T("Vous", "Developer"), [T("changelog_X.Y.Z.md", "changelog_X.Y.Z.md"), T("= la version", "= the version")], "blue"),
        (T("Contrôles locaux", "Local checks"), ["run_all.py", "check_version.py", "--check"], "blue"),
        ("make_release.py", [T("vérifie, tague", "checks, tags"), T("vX.Y.Z, pousse", "vX.Y.Z, pushes")], "blue"),
    ]
    for i, (a, ls, acc) in enumerate(top):
        x = 24 + i * 256
        strong, soft = ACC[acc]
        s.rect(x, 58, 232, 96, "#fff", LINE)
        s.p.append(f'<path d="M{x},{58+30} V{58+12} a12,12 0 0 1 12,-12 H{x+220} a12,12 0 0 1 12,12 V{58+30} Z" fill="{soft}"/>')
        s.text(x + 14, 79, f"{i+1} · {a}", 13.5, 800, strong, maxw=206)
        for j, ln in enumerate(ls):
            s.text(x + 14, 106 + j * 18, ln, 12, 400, INK2, maxw=206, mono=ln.endswith(".py") or ln.startswith("--") or ln.endswith(".md"))
        if i < 2:
            s.line(x + 234, 106, x + 254, 106, INK2, 2.2, arrow=True)
    s.line(652, 154, 652, 178, INK2, 2.2, arrow=True)
    s.rect(24, 180, 752, 160, ACC["amber"][1], ACC["amber"][0])
    s.text(40, 206, T("4 · Job « test » — rien ne sort s'il échoue", "4 · “test” job — nothing ships if it fails"), 14, 800, ACC["amber"][0])
    tests = [T("étiquette = changelog le plus récent", "tag = newest changelog"), T("dev_server.py --check", "dev_server.py --check"),
             T("201 fichiers de tests (--strict-skips --check-clean)", "201 test files (--strict-skips --check-clean)"),
             T("pas d'allow-same-origin dans un bac à sable", "no allow-same-origin in a sandbox"),
             T("pas de eval() / new Function() dans le code", "no eval() / new Function() in the code"),
             T("pas de <script src> venu d'Internet", "no <script src> from the Internet")]
    for i, t in enumerate(tests):
        cx = 40 + (i % 2) * 366
        cy = 224 + (i // 2) * 36
        s.pill(cx, cy, 350, 28, t, "amber", 12, 600)
    s.rect(24, 356, 752, 178, ACC["green"][1], ACC["green"][0])
    s.text(40, 382, T("5 · Job « release » — signé, puis publié d'un coup", "5 · “release” job — signed, then published at once"), 14, 800, ACC["green"][0])
    steps = [T("clé de signature obligatoire", "signing key mandatory"), T("pack de traitement complet", "complete processing pack"),
             T("zip signé + SHA256SUMS(.sig)", "signed zip + SHA256SUMS(.sig)"), T("signature revérifiée (clé épinglée)", "signature re-verified (pinned key)"),
             T("brouillon → tous les assets", "draft → all assets"), T("publication « dernière version »", "publish as “latest”")]
    for i, t in enumerate(steps):
        cx = 40 + (i % 3) * 245
        cy = 402 + (i // 3) * 54
        s.pill(cx, cy, 232, 36, t, "green", 11.5, 600)
    s.save()


# ---------------------------------------------------------------- 15
def tests():
    s = Svg("tests", 480, T("201 fichiers de tests : trois langages, une seule commande", "201 test files: three languages, one command"))
    bars = [("Node (.mjs, .js)", 124, "blue", T("le viewer, les workers, les protocoles", "viewer, workers, protocols")),
            ("Python", 55, "green", T("serveur, pipeline, import, migrations", "server, pipeline, import, migrations")),
            ("PHP", 22, "violet", T("le serveur jumeau", "the twin server"))]
    y = 70
    for lab, n, acc, note in bars:
        strong, soft = ACC[acc]
        s.text(24, y + 22, lab, 13, 700, INK)
        w = 400 * n / 124
        s.rect(160, y, w, 32, strong, strong, rx=8)
        s.text(160 + w + 10, y + 22, str(n), 14, 800, strong)
        s.text(160, y + 52, note, 11.5, 400, INK2)
        y += 72
    s.rect(24, 290, 420, 170, "#fff", LINE)
    s.text(40, 316, T("Les modes de run_all.py", "run_all.py modes"), 14, 800, INK)
    for i, (a, b) in enumerate([("-k texte", T("fichiers dont le chemin contient texte", "files whose path contains text")),
                                ("-j 4", T("quatre fichiers à la fois", "four files at a time")),
                                ("--timeout 600", T("limite par fichier", "limit per file")),
                                ("--strict-skips", T("un test sauté compte comme un échec", "a skipped test counts as a failure")),
                                ("--check-clean", T("un test qui salit le dépôt échoue", "a test that dirties the repository fails"))]):
        s.text(40, 342 + i * 24, a, 12, 700, ACC["blue"][0], mono=True, maxw=130)
        s.text(176, 342 + i * 24, b, 11.5, 400, INK2, maxw=262)
    s.rect(460, 290, 316, 170, ACC["teal"][1], ACC["teal"][0])
    s.text(476, 316, T("Les « jumeaux » testés ensemble", "The “twins” tested together"), 14, 800, ACC["teal"][0])
    for i, a in enumerate([T("un même vecteur de test, 3 langages :", "one test vector, 3 languages:"),
                           T("• compatibilité de version (42 cas)", "• version compatibility (42 cases)"),
                           T("• empreinte de confiance des plugins", "• plugin trust fingerprint"),
                           T("• import, notes de version, cache", "• import, release notes, cache")]):
        s.text(476, 344 + i * 26, a, 11.5, 400, INK, maxw=292)
    s.save()


# ---------------------------------------------------------------- 16
def hors_ligne():
    s = Svg("hors-ligne", 470, T("Ce qui marche sans Internet, et ce qui en demande", "What works without Internet, and what needs it"))
    s.rect(24, 54, 380, 394, ACC["green"][1], ACC["green"][0])
    s.text(40, 82, T("Sans Internet (réseau fermé d'un institut)", "No Internet (closed institute network)"), 14, 800, ACC["green"][0], maxw=350)
    items = [T("toutes les pages et leurs scripts", "all pages and their scripts"),
             T("Three.js, Lucide, Plotly : fichiers du site", "Three.js, Lucide, Plotly: site files"),
             T("vos jeux de données et le catalogue", "your datasets and the catalogue"),
             T("le panneau d'administration", "the administration panel"),
             T("l'import et les mises à jour de données", "import and data updates"),
             T("l'affichage 3D (carte graphique locale)", "3D display (local graphics card)")]
    for i, t in enumerate(items):
        s.text(40, 114 + i * 40, "✓", 15, 800, ACC["green"][0])
        s.text(64, 114 + i * 40, t, 13, 400, INK, maxw=330)
    s.rect(420, 54, 356, 250, ACC["amber"][1], ACC["amber"][0])
    s.text(436, 82, T("Demande Internet — l'administrateur seulement", "Needs Internet — the administrator only"), 13.5, 800, ACC["amber"][0], maxw=330)
    items2 = [("api.github.com", T("chercher une nouvelle version", "look for a new version")),
              ("github.com", T("télécharger la version et les packs", "download the release and packs")),
              ("raw.githubusercontent.com", T("lire le catalogue de plugins signé", "read the signed plugin catalogue"))]
    for i, (a, b) in enumerate(items2):
        s.text(436, 114 + i * 56, a, 12.5, 700, INK, mono=True, maxw=330)
        s.text(436, 134 + i * 56, b, 12, 400, INK2, maxw=330)
    s.text(436, 282, T("Un visiteur ne contacte jamais GitHub.", "A visitor never contacts GitHub."), 12, 700, ACC["amber"][0], maxw=330)
    s.rect(420, 318, 356, 130, ACC["grey"][1], ACC["grey"][0])
    s.text(436, 344, T("La seule exception côté visiteur", "The one exception on the visitor's side"), 13.5, 800, INK, maxw=330)
    s.text(436, 370, "fonts.googleapis.com  fonts.gstatic.com", 11.5, 600, INK2, mono=True, maxw=330)
    s.text(436, 394, T("Les polices ne gênent pas l'affichage :", "Fonts do not hold the page back:"), 12, 400, INK2, maxw=330)
    s.text(436, 414, T("sans réseau, la page s'affiche avec les polices", "without a network the page shows with the"), 12, 400, INK2, maxw=330)
    s.text(436, 432, T("du système.", "system fonts."), 12, 400, INK2, maxw=330)
    s.save()


# ---------------------------------------------------------------- 17
def versions():
    s = Svg("versions", 330, T("Quatre numéros, quatre rôles", "Four numbers, four roles"))
    cards = [
        (T("Plateforme web", "Web platform"), "1.59.3", T("le plus récent changelog/changelog_X.Y.Z.md", "newest changelog/changelog_X.Y.Z.md"), "blue"),
        (T("Pipeline", "Pipeline"), "0.21.0", "preprocess/run_preprocess.py", "green"),
        (T("Serveur Python", "Python server"), "0.16.0", T("dev_server.py : suit l'outil, dérive volontairement", "dev_server.py: tracks the tool, drifts on purpose"), "amber"),
        (T("Format des données", "Data format"), "4", T("metadata.json : formatVersion (écrit par le pipeline)", "metadata.json: formatVersion (written by the pipeline)"), "violet"),
    ]
    for i, (a, n, w, acc) in enumerate(cards):
        x = 24 + i * 188
        strong, soft = ACC[acc]
        s.rect(x, 62, 176, 232, "#fff", LINE)
        s.rect(x, 62, 176, 6, strong, strong, rx=3)
        s.text(x + 88, 98, a, 13.5, 800, strong, anchor="middle", maxw=160)
        s.text(x + 88, 160, n, 34, 800, INK, anchor="middle", maxw=160)
        words = w.split(" ")
        lines, cur = [], ""
        for wd in words:
            if len(cur) + len(wd) + 1 > 22:
                lines.append(cur); cur = wd
            else:
                cur = (cur + " " + wd).strip()
        lines.append(cur)
        for j, ln in enumerate(lines[:5]):
            s.text(x + 88, 198 + j * 18, ln, 11.5, 400, INK2, anchor="middle", maxw=164, mono=False)
    s.save()


# ---------------------------------------------------------------- 18
def installeur():
    s = Svg("installeur", 380, T("install.php : un fichier, six étapes", "install.php: one file, six steps"))
    st = [
        (T("Prérequis", "Prerequisites"), [T("PHP, zip,", "PHP, zip,"), T("écriture, réseau", "writing, network")]),
        (T("Téléchargement", "Download"), [T("par tranches,", "in slices,"), T("reprise (Range)", "resumable (Range)")]),
        (T("Vérification", "Verification"), [T("signature +", "signature +"), T("SHA-256 du zip", "zip SHA-256")]),
        (T("Extraction", "Extraction"), [T("par lots,", "in batches,"), T("entrées contrôlées", "entries checked")]),
        (T("Compte admin", "Admin account"), [T("mot de passe", "password"), T("≥ 8 caractères", "≥ 8 characters")]),
        (T("Verrouillage", "Locking"), [".install-lock", T("auto-suppression", "self-deletion")]),
    ]
    for i, (a, ls) in enumerate(st):
        x = 18 + i * 129
        acc = ["blue", "blue", "green", "blue", "violet", "amber"][i]
        strong, soft = ACC[acc]
        s.rect(x, 66, 118, 150, "#fff", LINE)
        s.p.append(f'<path d="M{x},{66+34} V{66+12} a12,12 0 0 1 12,-12 H{x+106} a12,12 0 0 1 12,12 V{66+34} Z" fill="{soft}"/>')
        s.text(x + 59, 90, str(i + 1), 18, 800, strong, anchor="middle")
        s.text(x + 59, 130, a, 12.5, 800, INK, anchor="middle", maxw=108)
        for j, ln in enumerate(ls):
            s.text(x + 59, 160 + j * 20, ln, 11.5, 400, INK2, anchor="middle", maxw=108, mono=ln.startswith("."))
        if i < 5:
            s.line(x + 119, 140, x + 128, 140, INK2, 1.8, arrow=True)
    s.rect(18, 240, 764, 112, ACC["amber"][1], ACC["amber"][0])
    s.text(34, 266, T("Garde-fous de l'installeur", "Installer safeguards"), 14, 800, ACC["amber"][0])
    for i, t in enumerate([T("• dépôt GitHub écrit en dur : aucune adresse n'est saisie par l'utilisateur", "• GitHub repository hard-coded: no address is typed by the user"),
                           T("• rien de destructif avant la fin d'une vérification réussie", "• nothing destructive before a successful verification"),
                           T("• refuse de tourner si un compte administrateur ou .install-lock existe", "• refuses to run if an admin account or .install-lock exists")]):
        s.text(34, 292 + i * 20, t, 12, 400, INK, maxw=730)
    s.save()

# ---------------------------------------------------------------- 19
def verrou_session():
    s = Svg("verrou-session", 462, T("PHP et le verrou de session : pourquoi l'administration restait lente", "PHP and the session lock: why the administration used to be slow"))
    for k, (title, acc, y0) in enumerate([(T("Avant : la session reste verrouillée jusqu'à la fin", "Before: the session stays locked until the end"), "red", 60),
                                         (T("Maintenant : la session est libérée dès qu'elle est lue", "Now: the session is released as soon as it is read"), "green", 250)]):
        strong, soft = ACC[acc]
        s.rect(24, y0, 752, 170, soft, strong)
        s.text(40, y0 + 26, title, 13.5, 800, strong, maxw=720)
        reqs = [("A", T("liste des jeux", "dataset list"), 3.0), ("B", T("un clic", "a click"), 0.9), ("C", T("autre onglet", "other tab"), 0.9)]
        t0 = 150
        x = t0
        for i, (n, lab, dur) in enumerate(reqs):
            y = y0 + 46 + i * 38
            s.text(44, y + 19, f"{n}  {lab}", 12, 600, INK, maxw=100)
            w = dur * 105
            if k == 0:
                s.rect(x, y, w, 26, ACC["blue"][1], ACC["blue"][0], rx=6)
                s.text(x + w / 2, y + 18, T("tient le verrou", "holds the lock") if i == 0 else T("travaille", "works"), 11, 600, ACC["blue"][0], anchor="middle", maxw=w - 6)
                if i > 0:
                    s.rect(t0, y, x - t0, 26, "#fff", ACC["red"][0], rx=6, dash="4 3")
                    s.text(t0 + (x - t0) / 2, y + 18, T("attend la session…", "waits for the session…"), 11, 400, ACC["red"][0], anchor="middle", maxw=x - t0 - 6)
                x += w
            else:
                s.rect(t0, y, 36, 26, ACC["amber"][1], ACC["amber"][0], rx=6)
                s.text(t0 + 18, y + 18, T("lit", "read"), 11, 600, ACC["amber"][0], anchor="middle")
                s.rect(t0 + 36, y, w, 26, ACC["blue"][1], ACC["blue"][0], rx=6)
                s.text(t0 + 36 + w / 2, y + 18, T("travaille", "works"), 11, 600, ACC["blue"][0], anchor="middle", maxw=w - 6)
    s.text(400, 446, T("api/admin.php, datasets.php, site.php, media.php, upload.php, migrations.php : session_write_close() dès l'ouverture",
                       "api/admin.php, datasets.php, site.php, media.php, upload.php, migrations.php: session_write_close() right after opening"), 11, 400, INK2, anchor="middle", maxw=780, mono=False)
    s.save()


for f in (trois_serveurs, chemin_requete, hebergement, cache, chargement, ranges, dossiers, proxy,
          maj_chaine, pivot, deux_maj, protege, signatures, release_pipeline, tests, hors_ligne,
          versions, installeur, verrou_session):
    f()
print(f"[{LANG}] 19 figures -> {os.environ.get('IMG_DIR', 'img dir')}")
for w in WARN:
    print("WARN", w)
