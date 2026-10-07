"""Schémas §13.3 : Comparer sous le capot."""
from svglib import P, INK, INK2, LINE, Svg, tr, measure, wrap


def architecture():
    s = Svg("compare-architecture.svg", 448)
    s.title(tr("Comparer : un hôte et jusqu'à quatre vraies pages", "Compare: one host and up to four real pages"))
    # hôte
    s.rect(20, 56, 760, 152, "#fff", P["blue"][0], 14, 1.8)
    s.text(36, 80, tr("Hôte : compare.html + compare.js (CompareApp)", "Host: compare.html + compare.js (CompareApp)"), 14, 800, P["blue"][0])
    mods = [("CompareQuality", tr("budget mémoire commun", "shared memory budget"), "green"),
            ("CompareTimeSync", tr("temps sans écho", "time without echo"), "amber"),
            ("ComparePanelRpc", tr("demandes / réponses", "requests / answers"), "violet"),
            (tr("file de chargement", "load queue"), tr("≤ 2 panneaux à la fois", "≤ 2 panels at a time"), "teal")]
    x = 36
    for name, sub, c in mods:
        st, so = P[c]
        s.rect(x, 96, 172, 66, so, st, 10, 1.3)
        s.text(x + 86, 120, name, 12.5, 800, st, "middle")
        s.text(x + 86, 142, sub, 11.5, 400, INK, "middle")
        x += 182
    # panneaux
    pans = [("viewer.html", tr("volume 3D", "3D volume"), "blue"), ("viewer.html", tr("série live", "live series"), "green"),
            ("viewer.html", tr("volume 3D", "3D volume"), "blue"), ("2d.html", tr("photographie", "photograph"), "amber")]
    x = 20
    for i, (page, sub, c) in enumerate(pans):
        st, so = P[c]
        s.rect(x, 262, 178, 104, "#fff", st, 12, 1.6)
        s.rect(x, 262, 178, 30, so, so, 12)
        s.rect(x, 278, 178, 14, so, so)
        s.text(x + 89, 282, tr(f"panneau {i + 1} (iframe)", f"panel {i + 1} (iframe)"), 12, 800, st, "middle")
        s.text(x + 89, 316, page, 12.5, 800, INK, "middle", 'font-family="JetBrains Mono, monospace"')
        s.text(x + 89, 334, f"hideHeader=true · panelIndex={i}", 10.5, 600, INK2, "middle")
        s.text(x + 89, 350, sub, 11, 400, INK2, "middle")
        s.arrow(x + 89, 210, x + 89, 258, st, 2, both=True)
        x += 194
    s.rect(170, 172, 460, 26, P["grey"][1], LINE, 13, 1)
    s.text(400, 190, "postMessage : " + tr("même origine · jamais « * » · event.source = la fenêtre de l'iframe", "same origin · never “*” · event.source = the iframe's window"), 11.5, 700, INK, "middle")
    s.rect(20, 384, 760, 46, P["red"][1], P["red"][0], 10, 1.2)
    s.para(34, 404, tr("L'hôte ne lit jamais le document d'un panneau (pas de contentDocument). Il demande, la page répond. Seule exception sanctionnée : les appels synchrones win.ViewerApp / win.App2D (capture, Studio, espace de travail).",
                       "The host never reads a panel's document (no contentDocument). It asks, the page answers. The one sanctioned exception: the synchronous win.ViewerApp / win.App2D calls (capture, Studio, workspace)."),
           732, 11.5, 400, INK)
    s.save()


def sequence():
    s = Svg("compare-sequence.svg", 640)
    s.title(tr("Ce qui se dit quand on ajoute un panneau", "What is said when a panel is added"))
    hx, px = 160, 640
    s.rect(hx - 70, 52, 140, 30, P["blue"][1], P["blue"][0], 8, 1.4)
    s.text(hx, 72, tr("Hôte (Comparer)", "Host (Compare)"), 13, 800, P["blue"][0], "middle")
    s.rect(px - 70, 52, 140, 30, P["green"][1], P["green"][0], 8, 1.4)
    s.text(px, 72, tr("Panneau (la page)", "Panel (the page)"), 13, 800, P["green"][0], "middle")
    s.line(hx, 84, hx, 628, LINE, 1.4, "4 4")
    s.line(px, 84, px, 628, LINE, 1.4, "4 4")
    steps = [
        ("h", tr("iframe.src = viewer.html?id=…&hideHeader=true&panelIndex=i&quality=512x512", "iframe.src = viewer.html?id=…&hideHeader=true&panelIndex=i&quality=512x512"), None),
        ("h", "APPLY_WORKSPACE_STATE", tr("(restauration seulement : avant le premier cadrage)", "(restore only: before the first framing)")),
        ("p", "PANEL_READY", tr("barre d'outils décrite · fonctions · coût de chaque qualité", "toolbar described · features · cost of each quality")),
        ("h", "SET_TOOL", tr("l'outil commun du moment", "the current shared tool")),
        ("h", "TOGGLE_ZSTACK · SET_CHANNEL_ACTIVE", tr("si une restauration ou « Décomposer » l'a réservé", "if a restore or “Decompose” reserved it")),
        ("h", "SYNC_CAMERA · SYNC_TIME · SYNC_CHANNELS …", tr("rattrapage : la dernière vue des autres (_replayLastSync)", "catch-up: the others' last view (_replayLastSync)")),
        ("h", "SET_QUALITY", tr("un panneau à la fois, selon le plan de budget", "one panel at a time, according to the budget plan")),
        ("p", "QUALITY_STATUS", tr("ready · error (la qualité demandée ou celle obtenue)", "ready · error (the quality asked for or obtained)")),
        ("h", "REQUEST_CAPTURE | REQUEST_STUDIO_SLICE | …", tr("plus tard : demande + requestId (délai 10 s ou 90 s)", "later: request + requestId (10 s or 90 s timeout)")),
        ("p", "CAPTURE | STUDIO_SLICE | …", tr("réponse avec le même requestId (image transférée, pas copiée)", "answer with the same requestId (image transferred, not copied)")),
    ]
    y = 112
    for who, name, sub in steps:
        c = P["blue"][0] if who == "h" else P["green"][0]
        if who == "h":
            s.arrow(hx + 2, y, px - 2, y, c, 2)
        else:
            s.arrow(px - 2, y, hx + 2, y, c, 2)
        w = measure(name, 12, 800)
        s.rect(400 - w / 2 - 8, y - 20, w + 16, 19, "#fff", c, 6, 1)
        s.text(400, y - 6, name, 12, 800, c, "middle")
        if sub:
            s.text(400, y + 16, sub, 11, 400, INK2, "middle")
        y += 52
    s.save()


def qualite():
    s = Svg("compare-qualite.svg", 512)
    s.title(tr("Le budget commun de 1,5 Gio : un exemple en trois temps", "The shared 1.5 GiB budget: an example in three steps"))
    s.text(400, 56, tr("Trois volumes de coûts différents (valeurs d'exemple, en Mio) ; budget fixe = 1 536 Mio ; plafond automatique = 1024", "Three volumes with different costs (example values, in MiB); fixed budget = 1,536 MiB; automatic ceiling = 1024"),
           12, 600, INK2, "middle")
    A = {"512": 180, "1024": 620}
    B = {"512": 240, "1024": 900}
    C = {"512": 90, "1024": 330}
    scale = 0.27  # px / Mio
    x0 = 190
    rows = [
        (tr("① départ : tous à 1024", "① start: all at 1024"), [("A", 620, "blue"), ("B", 900, "amber"), ("C", 330, "green")], tr("1 850 > 1 536 : trop", "1,850 > 1,536: too much"), "red"),
        (tr("② on abaisse le plus gros", "② lower the biggest"), [("A", 620, "blue"), ("B", 240, "amber"), ("C", 330, "green")], tr("B passe à 512 : 1 190", "B drops to 512: 1,190"), "green"),
        (tr("③ on tente de remonter", "③ try to raise"), [("A", 620, "blue"), ("B", 240, "amber"), ("C", 330, "green")], tr("B → 1024 coûterait +660 : refusé", "B → 1024 would cost +660: refused"), "green"),
    ]
    y = 96
    for head, segs, note, nc in rows:
        s.text(20, y + 24, head, 12.5, 800, INK)
        x = x0
        for name, v, c in segs:
            st, so = P[c]
            w = v * scale
            s.rect(x, y + 4, w, 36, so, st, 4, 1.6)
            s.text(x + w / 2, y + 27, f"{name} · {v}", 12, 800, st, "middle")
            x += w
        s.text(x0, y + 56, note, 12, 700, P[nc][0])
        y += 74
    # ligne du budget
    bx = x0 + 1536 * scale
    s.line(bx, 84, bx, 308, P["red"][0], 2, "6 4")
    s.text(bx + 4, 80, tr("1 536", "1,536"), 12, 800, P["red"][0], "middle")
    # règle
    s.rect(20, 322, 760, 172, P["grey"][1], LINE, 12, 1)
    s.text(36, 346, tr("Les deux boucles de CompareQuality.plan()", "The two loops of CompareQuality.plan()"), 13, 800, INK)
    items = [
        tr("Départ : chaque panneau au niveau où il est (512 à l'ouverture). Un panneau qui n'a pas encore chiffré ses niveaux compte pour 256 Mio.", "Start: each panel at the level it is on (512 at opening). A panel that has not yet priced its levels counts for 256 MiB."),
        tr("Tant que le total dépasse le budget : abaisser d'un cran le panneau qui occupe le plus.", "While the total exceeds the budget: lower by one notch the panel that holds the most."),
        tr("Puis, tant qu'un panneau peut monter d'un cran sans dépasser : monter celui qui est le plus bas (à égalité, la marche la moins chère), jamais au-dessus du plafond.", "Then, while some panel can go up one notch without exceeding: raise the lowest one (on a tie, the cheapest step), never above the ceiling."),
        tr("Plafond automatique : 1024 (les photographies n'ont pas de qualité). « Natif » n'est atteint qu'à la main.", "Automatic ceiling: 1024 (photographs have no quality). “Native” is only reached by hand."),
    ]
    y = 370
    for it in items:
        s.circle(40, y - 4, 3.5, P["blue"][0], P["blue"][0], 1)
        y = s.para(52, y, it, 712, 12, 400, INK) + 17
    s.save()


def temps():
    s = Svg("compare-temps.svg", 500)
    s.title(tr("Aligner deux séries de longueurs différentes : la fraction, pas le numéro", "Aligning two series of different lengths: the fraction, not the number"))
    # barres 100 et 10 images
    s.text(24, 78, tr("Série A : 100 images", "Series A: 100 frames"), 13, 800, P["blue"][0])
    s.text(24, 150, tr("Série B : 10 images", "Series B: 10 frames"), 13, 800, P["green"][0])
    s.rect(200, 62, 560, 22, "#fff", P["blue"][0], 6, 1.4)
    s.rect(200, 134, 560, 22, "#fff", P["green"][0], 6, 1.4)
    for k in range(10):
        x = 200 + k * 560 / 9
        s.line(x, 134, x, 162, P["green"][0], 1.2)
        s.text(x, 176, str(k), 10.5, 600, P["green"][0], "middle")
    frac = 50 / 99
    xf = 200 + frac * 560
    s.line(xf, 56, xf, 140, P["red"][0], 2, "5 3")
    s.circle(xf, 73, 6, P["red"][0], "#fff", 1.4)
    s.text(xf + 10, 52, tr("A choisit l'image 50 → fraction 50/99 = 0,505", "A picks frame 50 → fraction 50/99 = 0.505"), 12, 800, P["red"][0])
    bf = round(frac * 9)
    xb = 200 + bf * 560 / 9
    s.circle(xb, 145, 6, P["red"][0], "#fff", 1.4)
    s.text(xb, 200, tr("B tombe sur round(0,505 × 9) = image 5", "B lands on round(0.505 × 9) = frame 5"), 12, 800, P["red"][0], "middle")
    s.text(24, 232, tr("Le piège : l'écho", "The trap: the echo"), 14, 800, INK)
    s.card(24, 244, 360, 134, "red", tr("Sans protection", "Without protection"),
           tr("Si B signalait l'image 5 qu'on vient de lui demander, l'hôte la relaierait à A : 5 → fraction 5/9 = 0,556 → A sauterait à l'image 55, le signalerait à son tour : 50 → 5 → 55 …",
              "If B reported frame 5, which it was just asked to show, the host would relay it to A: 5 → fraction 5/9 = 0.556 → A would jump to frame 55 and report it in turn: 50 → 5 → 55 …"), body_size=12)
    s.card(416, 244, 360, 134, "green", tr("Avec CompareTimeSync", "With CompareTimeSync"),
           tr("Les pages actuelles ne signalent pas une image chargée sur ordre ; l'hôte double la garde : il note « j'ai demandé l'image 5 à B » (6 s, 16 ordres au plus) et ne relaie pas la réponse. Un geste de l'opérateur sur B, lui, est relayé.",
              "Current pages do not report a frame loaded on order; the host adds a second guard: it notes “I asked B for frame 5” (6 s, at most 16 orders) and does not relay the answer. An operator gesture on B is relayed."), body_size=12)
    s.rect(24, 392, 752, 92, P["grey"][1], LINE, 12, 1)
    s.text(40, 416, tr("La règle (viewer.js et compare-policy.js, identique des deux côtés) :", "The rule (viewer.js and compare-policy.js, identical on both sides):"), 12.5, 800, INK)
    s.text(40, 440, tr("si les longueurs diffèrent :  image = round( fraction × (N − 1) )   sinon : le même numéro", "if the lengths differ:  frame = round( fraction × (N − 1) )   otherwise: the same number"), 12.5, 700, P["violet"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.text(40, 464, tr("fraction = image / (N − 1), envoyée avec le numéro et la longueur totale de la série qui parle.", "fraction = frame / (N − 1), sent with the number and the total length of the series that speaks."), 12, 400, INK2)
    s.save()


def camera():
    s = Svg("compare-camera.svg", 360)
    s.title(tr("Synchroniser la caméra de deux embryons calibrés différemment", "Syncing the camera of two differently calibrated embryos"))
    s.card(20, 56, 230, 150, "blue", tr("Panneau A", "Panel A"),
           tr("Pose du cube Q_A. Calibration Q_baseA (axes du fichier → anatomie).", "Cube pose Q_A. Calibration Q_baseA (file axes → anatomy)."),
           body_size=12)
    s.text(34, 168, "Q_anat = Q_A · Q_baseA⁻¹", 13, 800, P["blue"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.arrow(254, 130, 308, 130, INK2, 2.4)
    s.card(312, 56, 168, 150, "violet", tr("L'hôte", "The host"),
           tr("Relaie SYNC_CAMERA sans le toucher, et garde le dernier message pour un panneau tardif.", "Relays SYNC_CAMERA untouched, and keeps the last message for a late panel."), body_size=12)
    s.arrow(484, 130, 538, 130, INK2, 2.4)
    s.card(542, 56, 238, 150, "green", tr("Panneau B", "Panel B"),
           tr("Reçoit Q_anat et pose son cube selon sa propre calibration :", "Receives Q_anat and poses its cube with its own calibration:"), body_size=12)
    s.text(556, 168, "Q_B = Q_anat · Q_baseB", 13, 800, P["green"][0], "start", 'font-family="JetBrains Mono, monospace"')
    s.rect(20, 226, 760, 120, P["grey"][1], LINE, 12, 1)
    s.para(36, 250, tr("Q_anat est une pose de l'anatomie (« face ventrale vers moi, antérieur en haut »), pas des axes de fichier. Deux embryons orientés différemment dans leur fichier regardent donc dans la même direction anatomique. Sans calibration, Q_base = identité.",
                       "Q_anat is a pose of the anatomy (“ventral face towards me, anterior up”), not file axes. Two embryos oriented differently in their files therefore look in the same anatomical direction. Without calibration, Q_base = identity."),
           728, 12.5, 400, INK)
    s.para(36, 308, tr("Les canaux, eux, se synchronisent par nom (« Pecam1 » à « Pecam1 ») ; la coupe Z-stack et le plan oblique par position normalisée ; une photographie par vue physique (µm par pixel d'écran).",
                       "Channels sync by name (“Pecam1” to “Pecam1”); the Z-stack slice and the oblique plane by normalised position; a photograph by physical view (µm per screen pixel)."),
           728, 12.5, 400, INK2)
    s.save()


def build():
    architecture()
    sequence()
    qualite()
    temps()
    camera()


if __name__ == "__main__":
    build()
