#!/usr/bin/env python3
"""Figures du chapitre 17 (les données en profondeur).

    python make_figures.py                       # français -> img/ch17
    FIG_LANG=en IMG_DIR=DOCS/documentation/img-en/ch17 python make_figures.py

Les arbres de fichiers et les tailles viennent des vrais jeux de démonstration de DATA_WEB/ ;
les schémas sont écrits à la main (svgs_*.py) ; les courbes et les journaux viennent des vrais
programmes (real_runs.py, gov_sim.mjs) dont les résultats sont rangés dans data/.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import svglib
import svgs_files
import svgs_migr
import svgs_import

svgs_files.run()
svgs_files.run2()
svgs_migr.run()
svgs_import.run()
for w in svglib.WARN:
    print("WARN", w)
