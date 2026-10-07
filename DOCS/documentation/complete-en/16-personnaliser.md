# 16. Customising and translating

::: chapter-intro
- Lumen3D **repaints itself in your colours without a line of code**: name, vocabulary, theme, pages, legal notices. It all fits in a few small JSON files in the `config/` folder.
- The site speaks **four languages** (English, French, Spanish, Dutch) with **1,943 texts** per language; adding a fifth language means dropping in a file.
- The site also looks after its visitors: a **light or dark theme** with no flicker, **colour-blindness simulation**, use on a phone, and **statistics with no personal data**.
:::

::: see
This chapter explains the **mechanics**: where each setting lives and how it reaches the screen. The step-by-step for each tab is in the "Administrator guide" (chapters 6 to 11); the overview is in chapter 14.
:::

## 16.1 One platform, many homes

Lumen3D was born to look at mouse embryos. Today it serves other objects: organs, samples, tissues. The **engine** does not change; what visitors read does.

::: analogy
**A hotel chain.** The walls, the wiring and the lift are the same everywhere (the engine). The reception, the sign, the restaurant menu and the decoration carry the name of the establishment (the configuration).
:::

Everything specific to *your* site lives in the **`config/`** folder:

![The config/ folder: each file, who reads it, and what the visitor sees of it.](img-en/ch16/config-carte.svg){width=76%}

::: remember
`config/` is **public**: any visitor can read these files. So **never put a secret** in it (passwords live in `api/`, which is never served).
:::

### The files, one by one

| File | What it contains | Edited in the tab… |
|--------|-------------------|-------------|
| `instance.json` | name, vocabulary, SEO, footer, menu, type names, variables | [Identity]{.ui}, [Data types]{.ui}, [Pages]{.ui} |
| `theme.json` | the colour, font and corner values you changed | [Appearance]{.ui} |
| `theme.css` | the style sheet **compiled** from `theme.json` | (generated, never by hand) |
| `legal.json` | the sections of the legal notice, per language | [Legal]{.ui} |
| `pages/<slug>.json` | one page per file: its published version | [Pages]{.ui} |
| `defaults/neutral/` | the neutral starting values, shipped with the platform | [Reset]{.ui} button |
| `uploads/` | the images sent from the page editor | page editor |

Next to it, outside `config/`: page **drafts** live in `api/page-drafts/` (private, see 16.6).

::: tech
**Updates and starting values.** `instance.json`, `theme.json`, `theme.css`, `legal.json` and `pages/` are on the list of what a platform update never touches: your settings survive. Uploaded images are part of no shipped version, so they are never replaced. The files in `defaults/neutral/`, on the other hand, travel with every version.

**The floor with no file.** If `instance.json` cannot be found or read, the browser falls back on a neutral vocabulary built into the code ("Lumen3D", "sample"). The server lets the fallback texts written in the pages play. The site does not break.

**Images.** They are limited to 8 MiB and to the PNG, JPG, WebP, GIF and AVIF formats. **SVG is deliberately refused**: served from the same domain, it could contain a script.
:::

## 16.2 `instance.json`, field by field

This is the richest file. Here is what each block really controls.

### Identity and organisation

| Field | Where it appears | Set in |
|-------|------------------|---------|
| `brand.name` | `{brand}` token; title of the `page.html` page | [Identity]{.ui} · *Instance name* |
| `brand.shortName` | `{brandShort}` token; title of the administration panel | *Short name* |
| `brand.productName` | `{product}` token | *Product name* |
| `brand.monogram` | the letters of the logo in the top bar (home, About…) | *Monogram* |
| `brand.logoEmoji` | the logo icon of the Explorer and of the administration panel | *Logo emoji* |
| `brand.organization` | **the text next to the logo** in the top bar; `{orgShort}` token | *Organization* |
| `brand.tagline` | `{tagline}` token (per language) | *Tagline* |
| `org.name` | `{org}` token | (first-install wizard) |

::: example
In the demonstration, the top bar shows "**IRIBHM — ULB**": that is `brand.organization`, not `brand.name` ("IRIBHM Microscopy Platform"). The monogram "**IR**" is in the green badge.
:::

### Vocabulary, search-engine optimisation, footer, menu

| Field | Where it appears | Set in |
|-------|------------------|---------|
| `specimen.singular`, `specimen.plural` | `{specimen}`, `{specimenPlural}` tokens and their capitalised versions | *Terminology* (per language) |
| `datasetTypes.<type>.label`, `.title` | badges, filters, home-page cards | [Data types]{.ui} |
| `seo.description`, `seo.keywords` | the `<meta>` tags of every page | *Tagline & SEO* |
| `pageTitles.<page>` | the browser-tab title of each page (`home`, `explorer`, `viewer`, `compare`, `2d`, `about`, `admin`, `legal`) | (file) |
| `footer.copyright` | the "© …" line of the footer | *Footer* |
| `nav.showExplorer`, `showCompare`, `showAbout` | show or hide the link in the bar | *Navigation* |
| `nav.showLegal` | adds the [Legal]{.ui} link **in the footer** | *Navigation* |
| `nav.customPages` | the pages you created (`slug`, label, visible) | added at first publication |

::: note
**Unticking hides the link, not the page.** If you untick [Show "Compare"]{.ui}, the address `compare.html` stays valid: only the link disappears from the bar. The pages you create are added after the links, in list order, with the label in the visitor's language.
:::

### The two fields that have no place on screen (yet)

::: warning
- **`org.url`** (*Organization link*) and **`footer.links`** (*Footer → Links*) can be entered and are **stored** in `instance.json`, but **no shipped page displays them** today. The footer shows the copyright, [About]{.ui}, [Contact]{.ui} and, if ticked, [Legal]{.ui}.
- To show an institution link, use a page of the editor (the [Link list]{.ui} or [Logo strip]{.ui} widget).
:::

### Settings with no administration screen

| Field | What it is for |
|--------|---------------------|
| `channelColorPresets` | the starting colour of a channel according to its name (see 16.8) |
| `variables` | your custom `{name}` variables (managed in the page editor, Variables tab) |

::: note
Each file carries its version identifier (`"$schema": "lumen3d-instance/1"`, `lumen3d-theme/1`, `lumen3d-legal/1`).
:::

## 16.3 How a value reaches the screen

Your institution's name appears in many places: in the browser tab, in the top bar, in the welcome sentence. Three mechanisms share the work, **all fed by the same file**.

![Three paths, one file: they cannot contradict each other.](img-en/ch16/trois-canaux.svg){width=86%}

### ① The server fills in the header

In every HTML page, the title and the description tags contain **markers**:

```html
<title>{{SITE:pageTitles.home|Lumen3D — 3D Imaging Data Viewer}}</title>
```

Before sending the page, the server replaces `{{SITE:path|fallback}}` with the value found in `instance.json`. If there is nothing (or not a character string), it puts the **fallback text** written after the `|`.

::: why
**Why on the server?** Search engines and link previews (messaging apps, social networks) read the header **without running any JavaScript**. Filling in the header before sending gives the right title from the very first byte, with no flicker.
:::

::: tech
- The value is **escaped** (`& < > "`) before entering the page: a name containing an angle bracket cannot break the HTML.
- Only **strings** are substituted: a "per-language" value (`{ "en": …, "fr": … }`) is not resolved here (the server does not know the visitor's language); the browser resolves it afterwards.
- The file is re-read only when it changes (its modification date is the key). Both servers (Python and PHP) apply the same rule.
:::

### ② The browser fills in the page

The logo, the footer and the menu carry `data-instance` attributes:

```html
<span data-instance="brand.organization">Lumen3D</span>
<a data-instance-attr="title:brand.tagline">…</a>   <!-- variant for an attribute -->
```

On load, `InstanceConfig` reads `instance.json` and writes the values: `data-instance` fills an element's **text**, `data-instance-attr` fills **attributes** ("attribute:path", separated by semicolons; the shipped pages do not need it today, but the mechanism is ready). It also applies the titles, the `<meta>` tags and the menu entries (`nav.*`).

::: tech
The text between the tags is the **fallback**: if the file cannot be found (offline, fresh install), the page shows this fallback instead of a hole. The application can be called again (after a language change, or when the administration preview reloads the configuration).
:::

### ③ Tokens in sentences

The language files **never contain** the word "embryo". They write a **token** between braces, which `I18n.t()` replaces at display time:

| Token | Comes from | Value in the demonstration |
|-------|-----------|-------------|
| `{brand}` | `brand.name` | IRIBHM Microscopy Platform |
| `{brandShort}` | `brand.shortName` | Lumen3D |
| `{product}` | `brand.productName` | Lumen3D |
| `{tagline}` | `brand.tagline` | Confocal Imaging Data Viewer |
| `{org}` | `org.name`, otherwise `brand.organization` | IRIBHM — Université Libre de Bruxelles |
| `{orgShort}` | `brand.organization`, otherwise `org.name` | IRIBHM — ULB |
| `{specimen}`, `{specimenPlural}` | `specimen.singular`, `.plural` **in the visitor's language** | embryo, embryos |
| `{Specimen}`, `{SpecimenPlural}` | the same, **first letter capitalised** | Embryo, Embryos |
| `{type3d}`, `{type2d}`, `{typeLive}` | the displayed name of each type | 3D, 2D, Live |

Thirteen tokens in all. The page editor lists them (in the [Variables]{.ui} tab), with a button to copy each one:

::: tech
**Order of resolution of a token**: first a value passed by the calling code (`{count}`, `{name}`…), then the instance token, otherwise the brace **stays as it is** on screen (an unknown token shows).

**A trap avoided.** The default type names themselves live in the language files (`types.3d.label`…). Reading them through `I18n.t()` would make the function that serves `t()` call `t()`: an endless loop. The code therefore reads this string through **`I18n.raw()`**, the same lookup *without* token replacement.
:::

:::: cols-wide-left
::: col
::: example
The key `landing.heroTitle` is `Explorez les {specimenPlural}` in French and `Explore {SpecimenPlural}` in English.

- with `specimen.plural.en = embryos` → "**Explore Embryos**";
- if the lab writes "organoids" → "**Explore Organoids**", without touching a single language file.
:::

The same tokens work in the **page texts** you write (16.6). The editor adds **dynamic variables** there: year, date, time, and the catalogue counters.
:::
::: col
![The instance tokens, seen from the page editor (demonstration dataset).](img-en/ch16/variables-marque.png){.shot width=100%}
:::
::::

### A "per-language" value

A specimen's name, a tagline, an SEO description: these texts depend on the language. They are written either as **a simple string** (identical everywhere) or as an **object per language**.

![A per-language value: answer with the visitor's language, otherwise English, otherwise the first one found.](img-en/ch16/localisable.svg){width=82%}

::: example
**The missing Dutch.** In the demonstration, `specimen.plural` exists in English, French and Spanish, but not in Dutch. A Dutch visitor therefore sees: "Verken **Embryos**": the sentence is Dutch, the noun is the English fallback, and it is capitalised because the token is `{SpecimenPlural}`.

This is not a fault, it is the fallback working: the fix is to fill in the **NL** line in the [Identity]{.ui} tab.
:::

![The home page in the four languages. The name of the object follows the language; in Dutch, it falls back to English for lack of an entry.](img-en/ch16/langues-accueil.png){.shot width=90%}

## 16.4 The customisation screens

### The Identity tab

![The Identity & branding tab (demonstration dataset).](img-en/ch16/identite.png){.shot width=78%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | **Identity** card: names, monogram, emoji, organisation. |
| 2 | **Terminology** card: the word for your objects of study, singular and plural. |
| 3 | **Tagline & SEO** card: tagline, description and keywords, per language. |
| 4 | **Footer** card: copyright (per language) and links (see 16.2: not displayed). |
| 5 | **Navigation** card: one box per entry of the public menu. [Show "Legal"]{.ui} is unticked by default. |
| 6 | [Save]{.ui}: active only when a field has changed. |
| 7 | A **multilingual** field: one line per available language. Here the **NL** line is empty. |
:::

Each multilingual field shows **as many lines as the platform has languages**: if you add a language (16.9), a line appears by itself.

### The Data types tab

![The Data types tab.](img-en/ch16/types-donnees.png){.shot width=78%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The number of datasets of this type (here 5 3D datasets). |
| 2 | **Short name**: one line per language. Empty = keep the default translation. |
| 3 | **Long title (home page)**: collapsible panel, for the large cards. |
| 4 | [Default names]{.ui}: **empties** the fields (you then have to save). |
| 5 | [Save]{.ui}. |
:::

Renaming "3d" to "Volumes" changes the **displayed word**, never the `DATA_WEB/3d/` folder, nor the addresses, nor the identifiers. The chain is: name entered → otherwise the `types.<type>` translation → otherwise the identifier itself.

::: tech
**A good practice in the code.** No screen writes a type name by hand: everything goes through `Utils.datasetTypeLabel()` and `datasetTypeTitle()`. An HTML element carrying `data-dataset-type="3d"` has its text rewritten by this mechanism, including at every language change.
:::

### Why two tabs do not overwrite each other

Three tabs write into the same `instance.json` file: Identity, Data types and the page editor (variables, menu). A tab left open for an hour must not erase the others' work.

::: analogy
**A shared notebook.** Everyone writes **on their own lines**: the server agrees to modify only the "paths" announced (`?merge=brand,specimen,…`) on the document **as it is now**, under a lock. There is no stale photocopy.
:::

For **pages**, one more protection: every read carries a **revision** (a fingerprint of the document). A save that arrives with a stale revision is **refused** (409 "stale") rather than overwriting a newer version.

### The first-install wizard

On the very first visit (no password exists), the panel opens a wizard in **five steps**. Only the first is mandatory.

::: steps
1. **Account**: the administrator's password.
2. **Identity**: instance name, organisation, name of the object (singular / plural).
3. **Theme**: a brand colour from six (green, blue, violet, turquoise, orange, crimson).
4. **Texts**: tagline and copyright line.
5. **Plugins**: the signed catalogue (chapter 15).
:::

At the end, the wizard writes only what you filled in: `brand` (the monogram takes the first two characters of the name, in capitals), `specimen`, possibly `org.name` and `footer.copyright`, then the colour tokens chosen, in `theme.json`.

## 16.5 The theme: colours, font, corners

The look of the site is driven by **CSS variables** (style "tokens"): `--color-primary`, `--font-sans`, `--radius-md`… The [Appearance]{.ui} tab changes only a handful of them, on purpose.

![The Appearance tab: five colours, a font, a corner radius, and a preview of the real site.](img-en/ch16/apparence.png){.shot width=78%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The **five brand colours**: primary, accent, success, error, warning. |
| 2 | The **font**: Inter (default), System, Grotesque, Serif, Rounded. |
| 3 | The **corner radius**: Standard, Sharp, Soft, Round. |
| 4 | The **live preview**: the real site in a frame, which changes instantly. |
| 5 | [Save]{.ui}: nothing is applied to the site before this click. |
:::

### From the click to every page

![The path of a theme setting, and the order of the style sheets.](img-en/ch16/theme-pipeline.svg){width=86%}

::: remember
The server lets through only variables whose name starts with `--`, and strips from each value the characters that could break a style sheet (`{ } ; < > \ @`); a value is cut at 200 characters. **A badly entered theme cannot destroy the whole sheet.**
:::

The `theme.css` sheet is loaded **after** `themes.css` (the factory dark/light theme) and before the layout sheets: it therefore **wins** over the factory values, but only for what you changed. The rest keeps coming from `variables.css`.

### One colour, five settings

A single colour picker is not enough: a button needs a hover shade, a dark shade, a subtle background. The editor **derives** them for you.

![A chosen colour (here #2F6BFF) and its derivatives.](img-en/ch16/theme-derives.svg){width=86%}

| Setting | Calculation |
|-----------|-------------|
| `--color-primary-hover` | lightness (HSL) **+ 8** points |
| `--color-primary-dark` | lightness **− 10** points |
| `--color-primary-subtle` | the same colour at **15%** opacity (accent: 12%) |
| `--color-primary-strong` | the colour mixed with **77%** black (hover: 64%) |

Success, error and warning derive in the same way (hover, subtle background at 12%).

### The contrast of white text

Solid buttons carry **white text** on `--color-primary-strong`. This is the whole point of the "strong" setting: the factory green (#00A654) gives only **3.19 : 1** under white, which is insufficient for text; darkened, it rises to **5.05 : 1**. The WCAG AA rule asks for **4.5 : 1**.

![Contrast of white text on the button, for the six colours offered by the wizard.](img-en/ch16/contraste.svg){width=82%}

::: warning
The calculation **darkens** the chosen colour; it checks nothing. Shades that are already dark fare well; **orange** (4.22) and **turquoise** (3.61) stay **below the threshold**. After changing the primary colour, look at your buttons in both themes.
:::

::: tech
Contrast is the WCAG relative-luminance ratio, `(L1 + 0.05) / (L2 + 0.05)`, where `L` is computed on the **linearised** RGB components (sRGB law). The figures above are recomputed by the figure script from the wizard's colours (`DOCS/documentation/img/ch16/make_figures.py`).
:::

### Light or dark

The **dark** theme is the default, by choice: a fluorescence image reads better on a black background. The visitor switches with one click; their choice is remembered **in their browser** (`iribhm-theme`).

![The same site in the dark theme (left) and the light theme (right).](img-en/ch16/theme-clair-sombre.png){.shot width=90%}

::: note
The theme is **not** tied to the system setting on the first visit. If the visitor has **never** chosen, a change of their system's light/dark setting is followed; as soon as they have chosen, their choice is what counts.
:::

Each theme also sets `color-scheme`: native drop-down menus, scroll bars and date pickers take the right look, with no light text on a white background.

### The 3D viewer's background: a separate setting

The **volume's background** does not follow the site's theme: it is a viewer setting, in the sidebar ([Background]{.ui}), remembered with the working state.

| Choice | Colour |
|--------|----------------|
| [Dark]{.ui} (default) | `#000000` |
| [Light]{.ui} | `#f4f6fb` |
| [Paper]{.ui} | `#f8f5ec` |
| [Transparent]{.ui} | no background (PNG exports keep the transparency) |
| [Custom]{.ui} | the colour you choose (`#1a1d27` to start with) |

::: tip
A **light** or **paper** background suits printed figures. An invalid colour code is refused with a console warning: the viewer keeps the choice's default colour rather than showing a random shade.
:::

## 16.6 The page builder

Home, About, or any page you create (protocols, team, contact…) are built **with the mouse**, as in a page-layout program.

![A page = sections (bands), columns (twelfths), widgets (bricks).](img-en/ch16/page-modele.svg){width=86%}

### The model: sections, columns, widgets

- A **section** is a band of the page: background, margins, maximum width.
- A **column** takes up **1 to 12 twelfths** of it; a section has **at most 6 columns** in the editor. On a phone, the columns **stack**.
- A **widget** is a brick of content. There are **27 types**.

::: analogy
**A newspaper.** The page is an issue, the sections are the horizontal bands, the columns are the newspaper's columns, the widgets are the articles, the photos and the boxed items.
:::

### The 27 widgets

![The 27 widgets, arranged as in the editor's palette.](img-en/ch16/widgets-27.svg){width=90%}

### What each widget does

| Widget | What it is, and its settings |
|-------|------------------------------|
| **Basics** | |
| [Heading]{.ui} | a section heading; heading level and alignment |
| [Text]{.ui} | a paragraph; mini formatting `**bold**`, `*italic*`, `[link](address)` |
| [Image]{.ui} | an image with caption and link; fit (fill or contain), width, height, alternative text |
| [Icon]{.ui} | a pictogram chosen from the icon library (with search); size, colour |
| [Button]{.ui} | label and link; variant, icon on the left or right, size, outline, full width |
| [Badges]{.ui} | small labels; coloured dot, monospaced font, colours |
| **Content** | |
| [Hero]{.ui} | the big home banner: title, subtitle, two buttons, badge, decorative glow, background |
| [Call-to-action]{.ui} | a box that invites a click: title, subtitle, two buttons |
| [Icon card]{.ui} | icon, image or monogram + title + text + link; horizontal or vertical layout |
| [Quote]{.ui} | text, author, role, photo; as a bar or a card |
| [Gallery]{.ui} | images in a grid; columns, captions, zoom on hover |
| [Profile]{.ui} | a person's card: name, role, description, media |
| [Copyable citation]{.ui} | a reference with a "copy" button and a collapsible block (BibTeX…) |
| [Animated counter]{.ui} | a number that counts up; fixed value **or** catalogue source; prefix, suffix |
| [Video]{.ui} | an `.mp4`/`.webm` file, or a YouTube/Vimeo link that opens **in a new tab**; preview image, loop, muted autoplay |
| [Logo strip]{.ui} | a row of partner logos; desaturated with colour on hover, light plate |
| **Lists & data** | |
| [Accordion / FAQ]{.ui} | questions that unfold; only one open at a time, the first open |
| [Timeline]{.ui} | a series of dated steps |
| [Stats]{.ui} | a row of key figures; fixed value **or** catalogue counter (datasets, specimens, cells, regions) |
| [Latest datasets]{.ui} | the cards of the most recent datasets; number, columns, type and date shown or not |
| [Icon list]{.ui} | a bulleted list with illustrated bullets; vertical or horizontal |
| [Tabs]{.ui} | content spread over tabs |
| [Link list]{.ui} | rows separated by thin rules, with an arrow: the sober way to present links |
| [Info sheet]{.ui} | a "label: value" table |
| **Structure** | |
| [Divider]{.ui} | a line; thickness, width, style (solid, dashed, dotted), colour |
| [Spacer]{.ui} | an adjustable gap from 0 to 400 pixels (32 by default) |
| [HTML]{.ui} | free HTML, **cleaned by an allow-list** (see below) |

::: tech
**Content security.** Text is always written with `textContent` (never interpreted as HTML). The HTML widget goes through an **allow-list**: scripts, event handlers, SVGs and `javascript:` links are removed; every `style` attribute is filtered declaration by declaration (no `position: fixed`, no `z-index`, no exotic URL). Links you enter refuse the `javascript:`, `vbscript:` and `data:` schemes. External videos are **not** embedded in the page: the site's security policy forbids third-party frames, hence the simple link.
:::

### An element's style

Each **widget**, **column** and **section** has its style settings, in seven families:

| Family | What you set there |
|-------|------------------------------|
| Text | colour (or a **gradient** painted into the letters), size, weight, line height, letter spacing, italic, capitals, alignment |
| Background & border | background colour or image, overlay, corner radius, border (thickness, colour, line), shadow (light, medium, large, glow), opacity |
| Spacing | margins and padding, side by side or linked |
| Size | maximum width, minimum height |
| Effects | on hover: lift, glow or zoom |
| Visibility | hide on mobile, or on desktop |
| Custom CSS | a few CSS declarations, **sanitised** before being applied |

::: tech
The style is compiled into **inline** CSS (`style` attribute), with no injected style sheet: the security policy forbids `<style>` elements added after the fact. Only the rules that really need a sheet (the `:hover` effect, the `@media` hiding by screen size) live in `css/pages.css`, a file of the site. Every value goes through a filter that removes anything that could break out of a declaration.
:::

### Variables, tokens and backgrounds

- **Dynamic variables**: `{year}`, `{date}`, `{time}`, and the counters `{datasetCount}`, `{specimenCount}`, `{cellCount}`, `{regionCount}` (computed at display time, in the visitor's language).
- **Instance tokens**: the thirteen of section 16.3 also work in page texts.
- **Your variables**: a name (a letter, then letters, digits or `_`, 32 characters at most) and a value, per language if needed. If their name is that of an existing variable, yours **wins**.
- **Animated backgrounds**: ten presets (floating particles, waves, aurora, starry sky, pulsing grid, constellation, orbs, cursor ripples, force field, halo). Five stand alone, five react to the mouse. With "reduce motion" turned on in the system, a single **still** drawing replaces the animation.

::: tip
`{…}` variables work in **all** page texts, but not in the language files (which have only the instance tokens).
:::

### Draft and publication

![Two files, two audiences: the draft is private, the published version is public.](img-en/ch16/brouillon-publication.svg){width=86%}

::: remember
**Nothing is public before [Publish]{.ui}.** While you work, visitors see the old version. The draft is saved automatically, but it is stored **outside `config/`**: that folder can be read without a password, and the editor saves about once a second while you write. A draft left in `config/` would have let anyone watch the operator write.
:::

This also sets common-sense rules for the editor:

- **"Publish"** first saves the draft, then *promotes* it to the public version.
- **"Default"** (original pages) returns to the shipped template; on a page of your own, it abandons the draft and returns to the published version.
- **One editing tab per page**: the second falls silent until you "take back control".
- The editor keeps **60 steps** of undo / redo.
- At the first [Publish]{.ui} of a page you created, it is added to the **menu** automatically.

### The editor on screen

The editor opens **in its own tab** (`admpan.html?editor=<page>`): the **real** page appears in a frame, with its real menu and its real theme; the editor adds a layer of handles on top.

![The page editor, on the "About" page (demonstration dataset).](img-en/ch16/editeur.png){.shot width=90%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The **page** being edited (the "built-in" label: it still uses the shipped template). |
| 2 | The **language** you are writing. |
| 3 | The five panels: [Elements]{.ui}, [Settings]{.ui}, [Background]{.ui}, [Translate]{.ui}, [Variables]{.ui}. |
| 4 | The **palette** of the 27 widgets, in four families. A click or a drag. |
| 5 | The **desktop / tablet / mobile** preview. |
| 6 | [Draft]{.ui}: saves without publishing. |
| 7 | [Publish]{.ui}: puts your version online. |
| 8 | **The real page**: click an element to select it. |
:::

The page's widgets are described by the **same code** for the editor and for the site (`PageRenderer`): what you see in the editor is exactly what will be published.

### The About page template

The **Home** and **About** pages exist from the start. As long as you have published nothing, the page shown is a **template** written in the same format as your pages (`js/core/page-templates.js`). It is both:

- what **visitors see** (there is no longer any fallback HTML hidden in `about.html`);
- the editor's **starting point**, which opens it with the "Starter template" label.

Its sentences are already written in English, French and Spanish, with tokens (`{brandShort}`, `{SpecimenPlural}`, `{org}`, `{year}`…): the page therefore carries **your** name before you have changed a word.

### Translating a page

The [Translate]{.ui} tab lists **all the texts** of the page, one field per language, and flags those that are missing ("24 texts · 7 missing translations"). There is **no machine translation**: nothing leaves your server.

::: tip
Recommended method: write the whole page in **one** language, then go to the Translate tab. Do not forget English: it is the fallback of all the other languages.
:::

### The limits

| Limit | Value |
|-----------|----------------|
| size of a page | 2 MB |
| sections per page | 300 |
| columns per section | 12 on the server, 6 in the editor |
| widgets per column | 500 |
| width of a column | 1 to 12 twelfths |
| address of a page (`slug`) | lower-case letters, digits, `-`, `_`; 64 characters at most |

A document outside the limits is **refused as a whole**, never half saved (only a column's width is simply brought back between 1 and 12). A deleted or unknown page sends you back to the home page rather than showing an empty page.

## 16.7 The legal notice

A public site needs a **publisher**, a **host**, a **data** policy. The [Legal]{.ui} tab is a deliberately simple editor: a list of **sections**, each with a title and a text, **per language**.

![The legal.html page, as a visitor sees it (neutral template, in English).](img-en/ch16/legal-public.png){.shot width=74%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The **title** of a section ("Publisher"). |
| 2 | The **text**: one paragraph per blank line. The `[square brackets]` are to be replaced by your information. |
:::

- As long as you have published nothing, the page shows the shipped **neutral template** (publisher, data protection, cookies and local storage, intellectual property, disclaimer, contact). It is written in **English, French and Spanish**.
- The text is displayed with `textContent`: no HTML, no formatting, one section per block.
- The link appears in the footer only if the [Show "Legal"]{.ui} box is ticked (unticked by default).

::: warning
These texts are **starting points**, not legal advice. Have them reviewed for your country. Remember that a web server generally keeps an **access log** (IP addresses) depending on its configuration: this is your host's business, and it is declared here (see 16.11).
:::

## 16.8 Where does a channel's starting colour come from?

When you open a dataset, every channel already appears in colour. Where does this colour come from? Chapter 11 shows how to **change** it; here is where it **comes from**.

![The first non-empty answer wins.](img-en/ch16/couleur-canal.svg){width=86%}

The panel takes the **first** answer available:

1. the dataset's **display settings** (`display_defaults`);
2. a `colors` list (old format);
3. the channel's colour in `metadata.json` (`channels[i].color`): the one the **pipeline** writes at the start, or that the **dataset editor** has saved;
4. a **preset by name** from the instance;
5. a **neutral cycle**: green, light blue, magenta, red.

### The preset by name

In `instance.json`, a `channelColorPresets` list associates a piece of name with a colour:

```json
{ "match": "dapi",  "color": "#00AAFF" },
{ "match": "pecam", "color": "#FF00FF" }
```

The channel name is lower-cased; **the first** `match` contained in the name wins. The demonstration contains eight: `gfp` (green), `dapi` and `hoechst` (light blue), `pecam` and `picam` (magenta), `rfp`, `mcherry` and `alexa` (red).

::: warning
Since the pipeline **always** writes a colour (step 3), the presets are in practice used only for datasets whose metadata has none. They have no administration screen: they are edited in `instance.json`.
:::

### Four colour lists, four uses

| Where | Colours |
|-------|-----------------|
| the **pipeline** (`metadata.json`) | `#00FF00`, `#00AAFF`, `#FF00FF`, `#FF0000`, `#FFFF00`, `#00FFFF` |
| the **dataset editor** (if nothing) | `#00FF66`, `#FF3DFF`, `#2F6BFF`, `#FF3030` |
| the **channel panel** (neutral cycle) | `#00FF00`, `#00AAFF`, `#FF00FF`, `#FF0000` |
| the dataset's **thumbnail** (Explorer image) | green, magenta, blue, red, yellow, violet, cyan |

::: note
These lists are not synchronised: they serve at different times. The colour **that counts** for the visitor is that of the channel panel, which starts from `metadata.json`. The picker's 27 colours, for their part, are fixed (chapter 11).
:::

## 16.9 Translating: how the site speaks four languages

The public site, the viewer, the administration and even the words of each tool are translated. It all rests on **one file per language** and a single function, `t('key')`, which returns the text in the visitor's language.

![Where each text of the site lives.](img-en/ch16/i18n-ou.svg){width=86%}

### The numbers

| | |
|---|---|
| languages shipped | **4**: English, French, Spanish, Dutch |
| texts per language | **1,943** (measured on the four `lang/*.json` files) |
| tool dictionaries | **28**, i.e. 240 texts in English |
| fallback language | **English**, always |

The 1,943 texts are distributed as follows:

| Key family | Texts | What it contains |
|--------|---|------------|
| `pages` | 485 | the page editor |
| `admin` | 365 | the administration panel |
| `viewer` | 182 | the viewer |
| `dupd` | 119 | the Data updates tab |
| `upl` + `upload` | 104 | the import |
| `compare`, `about`, `studio`, `tips`… | 688 | the rest |

::: remember
A key of one language **exists in all four**, with the **same `{…}` tokens**. An automatic test checks it at every version (`tests/js/test_build_lang_parity.mjs`): a missing or empty key, or one whose tokens change, makes the delivery fail.
:::

### Which language? Which sentence?

![Left: the choice of language at load. Right: the lookup of a text.](img-en/ch16/i18n-choix.svg){width=86%}

- **The choice.** The browser's `iribhm-lang` key (written when the visitor clicks in the menu); otherwise the browser's language ("fr-BE" becomes "fr"); otherwise English.
- **The loading.** English is read **first** (always), then the chosen language. If that file fails, the interface stays in English.
- **The propagation.** A click in the menu notifies the **other open pages** of the same origin (`storage` event): in Compare, the embedded panels change language with the host page.
- **The document.** The page's `lang` attribute follows the language; `dir="rtl"` is set for a right-to-left language (none is shipped).

![The language menu of the top bar: one button per language, with its flag and native name.](img-en/ch16/menu-langues.png){.shot width=74%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The [Language]{.ui} button. |
| 2 | The menu: generated **from the languages discovered**, English first, then alphabetical order. |
| 3 | The filter for colour-blind people (see 16.10). |
| 4 | The light / dark theme. |
:::

### Language discovery

The list of languages is **written nowhere by hand**: it is discovered, from the most to the least direct way.

::: steps
1. `GET api/languages.php`: the server lists the `lang/<code>.json` files (the name must be of the form `fr` or `pt-BR`).
2. Otherwise `lang/manifest.json`, the index that the Python server **rewrites** when the list changes, for static hosts.
3. Otherwise a fallback list built into the code: English, French, Spanish.
:::

::: tech
English is **always added** to the list, even if it was missing: the menu cannot be empty. Dutch is not in the fallback list: if both discoveries fail, it disappears from the menu.
:::

### The five ways to attach a text to an element

In the HTML, an attribute says which text the element displays:

| Attribute | What it fills |
|--------|------------------|
| `data-i18n="key"` | the element's text |
| `data-i18n-placeholder` | the greyed text of an input field |
| `data-i18n-title` | the tooltip |
| `data-i18n-aria` | the label read by a screen reader (`aria-label`) |
| `data-i18n-html` | a text that contains markup (rarely) |

The replacement takes place only if the key **exists**: otherwise the text written in the page (English) is kept, never a bare key.

### The tools' words

Each plugin carries its own texts: `js/modules/<family>/<id>/lang/<code>.json`. On load, they are filed **under `plugins.<id>`** in the same tree as the platform's texts.

- A plugin's list of languages is declared in its `plugin.json` (`i18nLanguages`): no attempt is made to load a file that does not exist.
- For each plugin, the **fallback is its own English**. The "sandboxed" screenshot plugin has no Spanish; a Spanish visitor sees it in English, without an error.
- On the Python server, the dictionaries travel **in the plugin-discovery answer** (one request fewer per plugin and per language); elsewhere, they are read file by file, and only English and the chosen language.
- A plugin that offers a language the platform does not have does not add it to the menu: only the platform decides.

### Adding a language

::: steps
1. **Copy** `lang/en.json` to `lang/de.json` (example: German) and translate the **values**, never the keys or the `{tokens}`.
2. **Reload**: the language appears in the menu (the code `de` is already known: "Deutsch", flag). An unknown code works too, with its abbreviation in capitals and a neutral flag.
3. **Plugins**: add `lang/de.json` to the tools you want to translate and complete `i18nLanguages`; without this, English.
4. **Your content**: a `DE` line appears by itself in the Identity, Data types, Legal tabs and in the page editor.
5. **Check** with `node tests/js/test_build_lang_parity.mjs` (keys, empties, tokens).
:::

::: note
Languages written right to left (Arabic is known to the code) receive `dir="rtl"`, but none is shipped: the layout has not been validated for them in this repository.
:::

### What happens if…?

| Situation | What the visitor sees |
|----------|----------|
| a key is missing in French | the **English** text |
| a key is also missing in English | the **key itself** ("landing.heroTitle") |
| `specimen.plural` has no `nl` line | the **English** name in the Dutch sentence |
| a language's value is empty | English (an empty line counts as absent) |
| a language file is unreadable | the interface stays in **English** |
| a plugin does not have the language | the **plugin's** English |
| a `{xyz}` token does not exist | `{xyz}` is displayed as it is |

## 16.10 Accessibility, theme and mobile

The accessibility of an imaging tool has limits (a 3D image remains an image). Here is what the code really does.

### Before the first display: the theme

![How the light theme arrives before the first display.](img-en/ch16/theme-boot.svg){width=86%}

::: tech
A small blocking script (`theme-boot.js`, a few lines) is placed in the `<head>`, after the style sheets. It reads the theme key and, if it is "light", changes the `data-theme` attribute **before** the page is painted. The administration panel loads it with its own key (`adm-theme`).
:::

### With a keyboard and a screen reader

- A **"Skip to content"** skip link is the first focusable element of every public page (9 pages out of 10: only the widget demonstration page, not shipped, has none); it leads to `<main id="main">`.
- Icon buttons carry a name (`aria-label`, or a translated tooltip); the text comes from the language files.
- Modal windows (`Dialog`) are declared `aria-modal`; when they offer a "cancel" way out, <kbd>Esc</kbd> or a click on the backdrop chooses it. Their text is written with `textContent`.
- The viewer's tools have shortcuts (V, C, M, I, D…): see chapter 12.
- The style sheets contain 25 occurrences of `:focus-visible`: the element that has keyboard focus is outlined.

### Reduced motion

If the system asks for "reduce motion", **all** the site's CSS animations and transitions are brought down to almost zero, and the pages' animated backgrounds become a still drawing. The viewer's camera movements (WebGL) are not CSS: they are not affected.

### The filter for colour-blind people

The eye-shaped button in the top bar opens the **"Colour Vision Deficiency Simulation"** menu: 9 choices in 5 groups.

![The simulation menu: for each choice, seven test shades already filtered.](img-en/ch16/daltonisme-menu.png){.shot width=78%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | The title: it is indeed a **simulation**. |
| 2 | The active choice (here "Off"). |
| 3 | Deuteranopia: no sensitivity to green. |
| 4 | Achromatopsia: no colour at all. |
:::

| Group | Complete deficiency | Partial deficiency |
|---|---|---|
| Red (protan) | protanopia | protanomaly |
| Green (deutan) | deuteranopia | deuteranomaly |
| Blue (tritan) | tritanopia | tritanomaly |
| Monochromacy | achromatopsia | achromatomaly |

The filter applies to the **whole page**, including the 3D viewer, to see what a person with the deficiency would see:

![The same embryo (demonstration dataset) with the DAPI, Pecam1, Sox2 channels, under four simulations.](img-en/ch16/daltonisme-viewer.png){.shot width=90%}

::: example
In this demonstration, the green and magenta of the normal view become, in protanopia and deuteranopia, **blues and beiges**: the red-green opposition that separated the two stainings disappears. In tritanopia, green becomes cyan and magenta pink. This is exactly what a publication figure should be checked for.
:::

![The same seven shades, computed by the script from the code's matrices.](img-en/ch16/daltonisme-teintes.svg){width=82%}

::: tech
- **The calculation.** Each simulation is a 3×3 matrix by **Machado, Oliveira and Fernandes (2009)**, applied to **linear** light (`color-interpolation-filters="linearRGB"`). The "-opia" types are severity 1.0 (cone absent); the "-omaly" types, severity 0.5. Each row sums to 1: a grey stays grey. Achromatopsia replaces the three channels by the luminance (0.2126 R + 0.7152 G + 0.0722 B); achromatomaly is the half-and-half mix.
- **Where it is attached.** The filter is placed on the root `<html>` element, not on `<body>`: a filter on any other element would make it the reference frame of its `position: fixed` descendants (top bar, windows, notifications), which would scroll with the page.
- **During the choice.** The page's filter is lifted while the menu is open, so that the previews (which have their own filter) are not filtered twice.
- **Memory.** The browser's `iribhm-colorblind` key; the Compare panels follow it through the `storage` event.
:::

::: warning
**It is not a correction.** The filter does not recolour the page to make it readable for a colour-blind person: it **shows** what they see, so that you can judge *your* figures. Nor is there any "colour-blind-friendly" palette shipped: channel colours are free. Advice from chapter 11: prefer green + magenta, or blue + yellow, to red + green.
:::

::: note
The simulation is a **display** effect: exports (capture, figure) are made from the render, not from the filtered screen. To judge a figure meant for print, export it and then look at the image under a simulation.
:::

### On a phone and a tablet

The site is **usable on a phone**, with limits that the viewer cannot lift.

![The home page, the Explorer, the viewer and its menu, on a screen 390 pixels wide (the last image shows the ☰ menu open).](img-en/ch16/mobile.png){.shot width=90%}

- **Touch.** One finger rotates the volume; **two fingers** move it and bring it closer (pinch). No modifier key is needed.
- **Collapsed toolbar.** When the buttons no longer fit on one line, they are tucked behind a ☰ button (third and fourth images).
- **Wider handles** on touch screens: the histogram handles go from 12 to 22 pixels.
- **Home.** Below 900 pixels, the links of the bar disappear (the bar keeps only language, filter and theme); you go through the page's buttons.
- **Studio.** Below 720 pixels, its panels stack under the image.

::: warning
**The limits are those of the hardware.** The viewer requires WebGL2; a phone's graphics memory is counted tightly (chapter 10). A large dataset at maximum quality may be refused there with a message: the site drops to the coarser level rather than crash.
:::

### Fonts

The site's only remote dependency is **Google Fonts** (Inter, JetBrains Mono). The link is loaded **deferred** (`media="print"`, switched on by `font-loader.js`): the page does not wait for it to display. Offline, or if the font is blocked, the browser uses its sans-serif font: the site stays readable.

## 16.11 Usage statistics

A lab wants to know whether its datasets are being looked at. Lumen3D tells it **without knowing anything about you**.

![What is counted, and what is not kept.](img-en/ch16/stats-stockage.svg){width=86%}

### What is counted

| Counter | When it goes up |
|-------|---------------------|
| **Visits** | once per **browsing session** (a tab), when the **home page** opens |
| **Views** | once per session and per dataset, when a dataset opens in the viewer |
| **Downloads** | when a file of a dataset's `download/` folder (the one the Download Center offers) is served **in full** |

::: tech
- The beacons are `POST` requests sent by `navigator.sendBeacon`, without waiting for an answer (they survive the closing of the tab). A `GET` is **refused** (405): a third-party image cannot inflate your figures.
- "Once per session" means: a `sessionStorage` key (`lumen_visit`, `lumen_view_<dataset>`) remembers that it has been done. It stays in the browser and disappears when the tab is closed.
- **Administration previews** (`mode=admin`) do not count: editing a dataset does not inflate its views.
- A visitor who arrives **directly** at a dataset (a link received by email) counts one **view** but no **visit**: only the home page counts visits.
- Downloads are counted **on the Python server side**, at the moment the file is served (a partial resume is not counted again). PHP hosts have the counting entry point but no code in the repository calls it for a download: their counter stays at zero.
:::

### What is kept: `api/stats.json`

Nothing but **numbers** and a date:

- `global`: visits, views, downloads, and the start date (`since`);
- `daily`: one line per **day** (never purged);
- `datasets`: per dataset (`3d/Embryo-…`), its views, its downloads, its last consultation.

**No IP address, no cookie, no visitor identifier, no browser, no country.** The file is protected from updates (your history survives) and is never served (it lives under `api/`).

::: tech
- A dataset's identifier must designate a dataset that **exists**: otherwise the beacon counts only globally. Without this check, anyone could have added thousands of fake datasets to the file.
- The figures accumulate in memory and are written **at most every 5 seconds**, when the administration reads them and when the server stops; the write is atomic (a temporary file replaces the old one).
:::

### Protecting against fraud: two token buckets

![Each beacon costs a token from two buckets; when empty, it receives 429.](img-en/ch16/limitation-debit.svg){width=86%}

::: analogy
**A ticket counter.** Each visitor has a small book of 60 tickets, refilled at one per second. The whole counter has a book of 600, refilled at 20 per second. Without a ticket in either, you are not served.
:::

The visitor's address is used **only** to choose one slot among the 4,096 of an in-memory table (its SHA-256 fingerprint is reduced to a number); it is **neither written to disk nor into `stats.json`**. Even the table never grows: two addresses that fall on the same slot simply start from a fresh book.

::: warning
The counters keep no personal data. This says nothing about the **access logs** of the web server itself (host, Apache…), which may contain IP addresses depending on its configuration: this must be declared in your legal notice (16.7).
:::

### Reading them

The [Statistics]{.ui} tab shows three cards (with the **last 30 days** plot drawn by hand in SVG, with no charting library) and a [By dataset]{.ui} table that you sort by clicking a header.

![The Statistics tab (test figures of the demonstration dataset).](img-en/ch16/stats.png){.shot width=78%}

::: legend
| n | what it is |
|--|----------------------|
| 1 | **Visits** (openings of the home page), with the curve of the last 30 days. |
| 2 | **Dataset views**: the most telling indicator. |
| 3 | **Downloads**. |
| 4 | The detail per dataset: views, downloads, last view. Click a header to sort. |
:::

Changing the **name** of a data type changes none of these figures. When moving from the old type vocabulary, the counters of the old keys are **added** to those of the new ones.

## 16.12 `PerfTelemetry`: the viewer's logbook

Not to be confused with the statistics. **`PerfTelemetry`** is an internal stopwatch that the viewer fills in to **diagnose** its performance.

![PerfTelemetry: a logbook that never leaves the tab.](img-en/ch16/perf-telemetrie.svg){width=86%}

::: remember
**Nothing is sent anywhere.** The logbook lives in the tab's memory, bounded (3,000 durations, 5,000 events, 500 measurements open at once), and disappears when the tab closes.
:::

### What the viewer records

| Measurement | What it times |
|---------|------------------|
| `viewer.init` | opening the page until the volume is ready |
| `viewer.timepoint.load` | loading one timepoint of a series |
| `volume.load.bricks` | loading the bricks of a quality level |
| `texture.upload.prepare` | preparing the texture before sending it to the graphics card |
| `viewer.frame_time` | smoothness: mean, median and 95th-percentile frame duration (every 4 seconds, after 45 frames) |
| `viewer.context_lost` / `restored` | a loss and a recovery of the graphics context |

### Reading it

In the browser console (F12): `PerfTelemetry.getSummary()`. You get, **per operation**, the number of occurrences, the minimum, the mean, the maximum, the median (p50) and the 95th percentile (p95), plus the last 80 events. It is a developer's tool, not a visitor's.

::: note
Only the viewer page loads `PerfTelemetry`. The progress line you see while loading a volume ("37% — level 2") is something else: a display, not a log.
:::

## 16.13 Summary

### I want to… where do I go?

| I want to… | I use |
|-------------|-------------|
| change the name, the organisation, the logo | [Identity]{.ui} |
| change the word "embryo" everywhere | [Identity]{.ui} › *Terminology* |
| rename "3D", "2D", "Live" | [Data types]{.ui} |
| change the site's green, the font, the corners | [Appearance]{.ui} |
| edit the home page, the About page | [Pages]{.ui} |
| create a "Protocols" page | [Pages]{.ui} › [New page]{.ui} |
| write the legal notice | [Legal]{.ui}, then tick the box in [Identity]{.ui} |
| add a language | drop in `lang/<code>.json` |
| give channels a colour according to their name | `channelColorPresets` in `instance.json` |
| find out how many people look at my data | [Statistics]{.ui} |

### Frequent mistakes, explained

| Observation | Explanation |
|-----------|-------------|
| "My Appearance change does not show" | it is applied only after [Save]{.ui}; clear the cache if the browser keeps the old `theme.css` |
| "The Legal link has disappeared" | the box is unticked by default in [Identity]{.ui} |
| "My footer links are not displayed" | see 16.2: they are saved but not displayed |
| "The Dutch talks about embryos" | the **NL** line of *Terminology* is empty |
| "My page is saved but invisible" | the draft is saved; you must [Publish]{.ui} |
| "The editor says the page is open elsewhere" | another tab is editing it: take back control or close the other |

### Going further

::: see
- **Step by step**: Administrator guide, chapters 6 (Data types), 7 (Statistics), 8 (Identity), 9 (Appearance), 10 (Pages), 11 (Legal).
- **The tests** that lock this chapter down: `tests/js/test_build_lang_parity.mjs` (language parity), `tests/js/test_plugin_lang.mjs` (plugin languages), `tests/test_dev_server_site.py` (configuration store, `{{SITE:…}}` markers, theme compilation), `tests/js/test_admin_pages_save.mjs` (draft, revision, lock), `tests/js/test_admin_branding_merge.mjs` (saving by paths), `tests/test_v3_minor_telemetry.py` (token buckets).
- **The security** of these mechanisms (allow-lists, content security policy, file permissions): chapter 19. **Plugins** and their languages: chapter 15. **Updates** that preserve `config/`: chapter 18.
:::
