"""Génère tous les schémas SVG du chapitre 13.

    python svgs.py                                   # français -> ce dossier
    FIG_LANG=en IMG_DIR=../../img-en/ch13 python svgs.py
"""
import importlib

for mod in ["svgs_tracking", "svgs_studio", "svgs_compare", "svgs_2d", "svgs_state"]:
    try:
        m = importlib.import_module(mod)
    except ModuleNotFoundError as e:
        if e.name == mod:
            continue
        raise
    print(mod)
    m.build()
