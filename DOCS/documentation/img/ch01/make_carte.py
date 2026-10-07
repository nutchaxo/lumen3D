#!/usr/bin/env python3
"""Documentation map of chapter 1 (carte.svg), 21 chapters.

    FIG_LANG=fr IMG_DIR=DOCS/documentation/img/ch01    python3 make_carte.py
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch01 python3 make_carte.py
"""
import os
from xml.sax.saxutils import escape

LANG = os.environ.get("FIG_LANG", "fr")
OUT = os.environ.get("IMG_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)
PAL = {"blue": ("#3b5bdb", "#e8edff"), "green": ("#2b8a3e", "#ebfbee"), "teal": ("#0c8599", "#e3fafc"),
       "violet": ("#7048e8", "#f3f0ff"), "amber": ("#e67700", "#fff4e6")}

TX = {
    "fr": {
        "title": "Carte de la documentation : quelle question, quel chapitre ?",
        "groups": [
            ("Découvrir", "chapitres 1 à 3", "blue", [
                "À quoi sert Lumen3D ? Quels types de données ?",
                "Quelles technologies, et à quoi servent-elles ?",
                "Où cliquer ? À quoi ressemble chaque page ?"]),
            ("Préparer", "Python, chapitres 4 à 8", "green", [
                "Que contient un fichier Imaris ?",
                "Comment le bruit de fond est-il retiré ?",
                "Comment passer de 14 Go à quelques centaines de Mo ?",
                "Que sont les briques, les packs, les niveaux de détail ?",
                "Métadonnées, suivi cellulaire, publication sans risque"]),
            ("Afficher", "le navigateur, chapitres 9 à 13", "teal", [
                "Comment l'image 3D est-elle calculée ?",
                "Comment afficher des gigaoctets sans attendre ?",
                "Couleurs, contrastes, histogrammes : que signifient-ils ?",
                "Que fait chaque outil de la barre d'outils ?",
                "Comment les outils fonctionnent-ils sous le capot ?"]),
            ("Administrer", "et étendre, chapitres 14 à 18", "violet", [
                "Que peut faire l'administrateur ? (aperçu)",
                "Plugins : installation, confiance, catalogue signé",
                "Changer le nom, les couleurs, les langues, les pages",
                "Fichiers, formats, conversions et import en détail",
                "Héberger, mettre à jour, publier une version"]),
            ("Se fier", "et retrouver, chapitres 19 à 21", "amber", [
                "Mes données sont-elles protégées ? Que se passe-t-il en cas de panne ?",
                "Où est quoi dans le code ? Que ne fait-il pas ? Quels chiffres ?",
                "Que veut dire ce mot ? (glossaire)"]),
        ],
    },
    "en": {
        "title": "Documentation map: which question, which chapter?",
        "groups": [
            ("Discover", "chapters 1 to 3", "blue", [
                "What is Lumen3D for? Which data types?",
                "Which technologies, and what are they for?",
                "Where to click? What does each page look like?"]),
            ("Prepare", "Python, chapters 4 to 8", "green", [
                "What is inside an Imaris file?",
                "How is the background noise removed?",
                "How do you go from 14 GB to a few hundred MB?",
                "What are bricks, packs and levels of detail?",
                "Metadata, cell tracking, risk-free publishing"]),
            ("Display", "the browser, chapters 9 to 13", "teal", [
                "How is the 3D image computed?",
                "How to display gigabytes without waiting?",
                "Colours, contrast, histograms: what do they mean?",
                "What does each toolbar tool do?",
                "How do the tools work under the hood?"]),
            ("Administer", "and extend, chapters 14 to 18", "violet", [
                "What can the administrator do? (overview)",
                "Plugins: installation, trust, signed catalogue",
                "Change the name, colours, languages, pages",
                "Files, formats, conversions and import in depth",
                "Host, update, publish a release"]),
            ("Trust", "and look up, chapters 19 to 21", "amber", [
                "Is my data protected? What happens when something fails?",
                "What is where in the code? What does it not do? Which figures?",
                "What does this word mean? (glossary)"]),
        ],
    },
}[LANG]

ROW = 24
h = 62 + sum(len(g[3]) * ROW + 26 for g in TX["groups"]) + 10
s = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 {h}" font-family="Inter, sans-serif">\n'
     f'<rect width="800" height="{h}" rx="16" fill="#f8f9fd"/>\n'
     f'<text x="400" y="34" text-anchor="middle" font-size="17" font-weight="800" fill="#1c2333">{escape(TX["title"])}</text>\n')
y = 52
n = 1
for name, sub, color, items in TX["groups"]:
    st, so = PAL[color]
    gh = len(items) * ROW + 16
    s += f'<rect x="24" y="{y}" width="752" height="{gh}" rx="12" fill="#fff" stroke="#c5cbd8"/>\n'
    s += f'<rect x="24" y="{y}" width="170" height="{gh}" rx="12" fill="{so}"/>\n'
    s += f'<text x="109" y="{y + gh / 2 - 2}" text-anchor="middle" font-size="14" font-weight="800" fill="{st}">{escape(name)}</text>\n'
    s += f'<text x="109" y="{y + gh / 2 + 16}" text-anchor="middle" font-size="11" fill="#4a5468">{escape(sub)}</text>\n'
    for i, it in enumerate(items):
        yy = y + 24 + i * ROW
        s += (f'<text x="208" y="{yy}" font-size="12.5" fill="#1c2333"><tspan font-weight="800" fill="{st}">{n}</tspan>'
              f'<tspan dx="8">{escape(it)}</tspan></text>\n')
        n += 1
    y += gh + 10
s += '</svg>\n'
open(os.path.join(OUT, "carte.svg"), "w", encoding="utf-8").write(s)
print("wrote", os.path.join(OUT, "carte.svg"), h)
