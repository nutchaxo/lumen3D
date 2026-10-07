# Writing the Lumen3D documents — style guide

Applies to the documents built by `DOCS/build/build_docs.py`:

| Document | Languages | Sources | Images |
|---|---|---|---|
| Administrator guide | FR, EN, ES, NL (+ MULTI = the four merged) | `DOCS/admin-guide/GUIDE-ADMINISTRATEUR.md`, `GUIDE-EN.md`, `GUIDE-ES.md`, `GUIDE-NL.md` | `img/`, `img-en/`, `img-es/`, `img-nl/` |
| Full documentation | EN (reference), FR | `DOCS/documentation/complete-en/*.md`, `complete/*.md` (concatenated in name order) | `img-en/chNN/`, `img/chNN/` |
| Essentials | EN, FR | `DOCS/documentation/ESSENTIALS-EN.md`, `ESSENTIALS-FR.md` | `img-en/ess/`, `img/ess/` |

Each language version is a full document with its own screenshots (UI in that language) and
figures (text in that language). Set `lang:` and `toc-title:` in the front matter: the box
labels follow `lang` (docs.css).

## 1. Reader and tone

* Written for a **biologist** (French: « vous »; English: plain "you") who has never
  read code. Precise, never vague: every number comes from the code.
* The reader has **ADHD**: no wall of text. Rules:
  - a paragraph is **at most 4 lines**; prefer bullet lists and tables;
  - **every page carries at least one visual** (figure, screenshot, schema, table, box);
  - every chapter opens with a `::: chapter-intro` or `::: tldr` box (3 bullet points);
  - one idea per section; short headings that say what you will learn;
  - technical depth goes in `::: tech` boxes (small grey text) the reader may skip.
* Explain a technical word the first time with an everyday analogy (`::: analogy`) and
  put it in the glossary. Avoid jargon when a plain word exists.
* Prefer concrete **micro-examples with real numbers** (`::: example`): « un voxel de
  valeur 120 avec min = 20 et max = 220 devient 0,5 ».

## 2. Markdown conventions (pandoc)

* `# 5. Titre du chapitre` — a level-1 heading starts a new page (numbered by hand).
* `## 5.2 Titre` sections, `### …` sub-sections (sub-sections are not in the summary).
* `## 5.3 Titre {.page}` forces a page break before a section.
* Boxes (fenced divs), each gets its own colour and label automatically:
  `::: tldr` (En 30 secondes) · `::: analogy` (Une image pour comprendre) ·
  `::: example` (Micro-exemple) · `::: warning` (Attention) · `::: tech` (Pour les curieux) ·
  `::: tip` (Astuce) · `::: note` (À savoir) · `::: why` (Pourquoi ce choix ?) ·
  `::: remember` (À retenir) · `::: see` (Pour aller plus loin)
* Layout: `:::: cols` (2 columns) whose children are `::: col` divs (one per column; never
  `::: {}`, pandoc does not accept an empty attribute block as an opening fence); also
  `:::: cols3`, `:::: cols-wide-left`, `:::: cols-wide-right`. Use one more colon on the outer
  fence than on the inner ones.
* Cards: `:::: cards` (3 per row; `{.cards .two}` / `{.cards .four}`) containing `::: card` divs,
  a card may start with `#### Titre` and use `[42 %]{.big}`.
* Key figures: `:::: keynums` containing `::: keynum` divs with `**64³**` then a short label.
* Big numbered steps: `::: steps` wrapping an ordered list.
* Inline: `[Enregistrer]{.ui}` for an on-screen button/label (always the exact FRENCH text),
  `[format 4]{.pill}` (`.green`, `.amber`, `.red`, `.grey`), `[3]{.callout-num}` to refer to a
  numbered callout of a screenshot, `<kbd>Ctrl</kbd>`.
* Figures: `![Légende courte et utile.](img/ch05/masque.svg){width=85%}` — a figure alone in its
  paragraph gets a caption. Screenshots: add `.shot` → `![…](img/ch03/explorer.png){.shot width=95%}`
 (the class lands on the `<img>`, styled by `img.shot`).
* Tables: pipe tables; keep them narrow (≤ 4 columns). A legend of numbered callouts is a
  2-column table `| n | ce que c'est |` wrapped in `::: legend` (narrow red number column).

## 3. Figures

* Folder per chapter: `DOCS/documentation/img/chNN/` (admin guide: `DOCS/admin-guide/img/`).
* **Schemas are hand-written SVG** (`viewBox="0 0 800 H"`, `font-family="Inter, sans-serif"`),
  see `DOCS/documentation/img/ch01/parcours.svg` for the reference look:
  - background card `#f8f9fd`, rounded rectangles `rx 12–16`, strokes `#c5cbd8`;
  - text ink `#1c2333`, secondary `#4a5468`; titles 16–18 px bold, body 12–14 px;
  - accent pairs (strong / soft): blue `#3b5bdb`/`#e8edff`, green `#2b8a3e`/`#ebfbee`,
    amber `#e67700`/`#fff4e6`, violet `#7048e8`/`#f3f0ff`, teal `#0c8599`/`#e3fafc`,
    red `#c92a2a`/`#fff0f0`;
  - arrows with a `marker` (see reference); emoji allowed sparingly as pictograms;
  - text must never overflow its box: check the rendering.
* **Data figures** (histograms, curves, real images at each processing step) are generated
  with Python (numpy / matplotlib / Pillow) from real data — keep the generating script
  next to the images: `DOCS/documentation/img/chNN/make_figures.py`. Use the same palette,
  font Inter, white background, PNG at 2× (dpi ≥ 160) or SVG.
* **Screenshots**: PNG, 1600 px wide max, French UI; numbered red callouts are drawn with the
  screenshot helper. Refer to callouts in a table `| n | ce que c'est |` right under the image.

## 4. Checking your pages

```
python DOCS/build/build_docs.py --preview DOCS/documentation DOCS/documentation/complete/05-*.md \
       --out /tmp/…/ch05.pdf --png /tmp/…/ch05-png
```
then look at the PNG pages (`p-01.png` is the cover of the preview, skip it). Fix overflowing
text, empty half pages, figures split from their caption, too-dense pages.
