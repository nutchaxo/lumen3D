/* ============================================================
   Lumen3D — Built-in page templates (white-label)
   ============================================================
   The DEFAULT content of the built-in "about" page, expressed in the
   page-builder's own model (sections → columns → widgets, exactly what
   js/pages/admin/tab-pages.js would produce). One source, two consumers:

     • about.html / js/pages/about.js — renders it through PageRenderer when
       the operator has not published a page of their own. Since v1.25.0 the
       About page has NO hardcoded HTML fallback: what visitors see IS this
       document, so "what you edit" and "what ships" can never drift.
     • the admin Pages tab — seeds the editor with it the first time the
       built-in page is opened.

   COPY IS EMBEDDED, NOT KEYED. Page-builder text belongs to the document
   (the operator edits it per-locale in the editor), not to lang/*.json — so
   each string here is a localized object {en, fr, es}. White-label tokens
   ({brandShort}, {tagline}, {SpecimenPlural}, {org}, {year}…) are resolved at
   render time by PageRenderer._interp, so the default page already reads as
   the operator's own instance before a single edit. Every sentence must still
   read correctly when an optional token ({org}) resolves to an empty string —
   hence tokens sit in labelled rows and eyebrows, never mid-sentence.

   Classic IIFE singleton — bare name PageTemplates (no window.*, see §8 of
   CLAUDE.md). Referenced from the ESM admin panel by bare name too: a
   top-level `const` in a classic script lives in the global lexical
   environment, which module scope also chains to.
   ============================================================ */

const PageTemplates = (() => {
  'use strict';

  // Style objects are per-call factories: two widgets must never share one
  // reference, or editing one would silently mutate the other.
  const EYEBROW = () => ({ fontSize: 11, fontWeight: 700, uppercase: true, letterSpacing: 2, color: 'var(--color-primary)' });
  const CHAPTER_H = () => ({ fontSize: 30, lineHeight: 1.2, letterSpacing: -0.4 });
  const DECK = () => ({ fontSize: 14, lineHeight: 1.65, color: 'var(--text-muted)' });
  const ACCENT_GRADIENT = 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-accent) 100%)';

  const SEC = (props, columns) => ({
    props: Object.assign({ bg: '', padY: 88, fullWidth: false, maxWidth: 1120, gap: 56, vAlign: 'stretch' }, props),
    columns,
  });

  // The editorial device this page is built on: a narrow left column carrying
  // an eyebrow + chapter title (+ optional deck), facing the content column.
  // It replaces the centered "big heading over a row of cards" rhythm.
  const chapterLabel = (eyebrow, title, deck) => ({
    width: 4,
    props: {},
    widgets: [
      { type: 'richtext', text: eyebrow, props: { align: 'left', style: EYEBROW() } },
      { type: 'heading', text: title, props: { level: '2', align: 'left', style: CHAPTER_H() } },
      ...(deck ? [{ type: 'richtext', text: deck, props: { align: 'left', style: DECK() } }] : []),
    ],
  });

  const counter = (source, label) => ({
    width: 3,
    props: {},
    widgets: [{
      type: 'counter',
      text: label,
      props: {
        source, value: '', align: 'center', size: 46, color: ACCENT_GRADIENT,
        // The style object lands on the widget root: the number pins its own
        // size and colour, so only the label picks these up.
        style: { fontSize: 12, uppercase: true, color: 'var(--text-secondary)' },
      },
    }],
  });

  function about() {
    return [
      // ── 1. Masthead ────────────────────────────────────────────────────────
      SEC({ padY: 100 }, [{ width: 12, props: {}, widgets: [{
        type: 'hero',
        text: { en: 'About {brandShort}', fr: 'À propos de {brandShort}', es: 'Acerca de {brandShort}' },
        props: {
          badge: { text: { en: '{tagline}', fr: '{tagline}', es: '{tagline}' }, dot: true },
          subtitle: {
            en: '{brandShort} makes multi-gigabyte 3D imaging volumes explorable in a plain web browser — real-time rendering, calibrated measurements, and a workspace state you can save, reopen and share.',
            fr: '{brandShort} rend explorables, dans un simple navigateur, des volumes d\'imagerie 3D de plusieurs gigaoctets — rendu temps réel, mesures calibrées, et un état de travail que l\'on peut enregistrer, rouvrir et partager.',
            es: '{brandShort} permite explorar volúmenes de imagen 3D de varios gigabytes en un simple navegador: renderizado en tiempo real, mediciones calibradas y un estado de trabajo que se puede guardar, reabrir y compartir.',
          },
          align: 'left', glow: true, titleSize: 56, subSize: 19,
          cta: { text: { en: 'Explore the data', fr: 'Explorer les données', es: 'Explorar los datos' }, href: 'explorer.html' },
          bg: '',
          // Flush with the section: the masthead is the page, not a card on it.
          style: { radius: 0, padTop: 8, padBottom: 8, padLeft: 0, padRight: 0 },
        },
      }] }]),

      // ── 2. Live figures ────────────────────────────────────────────────────
      SEC({ padY: 46, gap: 24, bg: 'color-mix(in srgb, var(--color-primary) 5%, transparent)' }, [
        counter('datasetCount', { en: 'Datasets', fr: 'Jeux de données', es: 'Conjuntos de datos' }),
        counter('specimenCount', { en: '{SpecimenPlural}', fr: '{SpecimenPlural}', es: '{SpecimenPlural}' }),
        counter('cellCount', { en: 'Tracked cells', fr: 'Cellules suivies', es: 'Células rastreadas' }),
        counter('regionCount', { en: 'Annotated regions', fr: 'Régions annotées', es: 'Regiones anotadas' }),
      ]),

      // ── 3. The project ─────────────────────────────────────────────────────
      SEC({ padY: 96 }, [
        chapterLabel(
          { en: 'The project', fr: 'Le projet', es: 'El proyecto' },
          { en: 'Built for heavy data', fr: 'Conçue pour la donnée lourde', es: 'Pensada para datos pesados' },
        ),
        { width: 8, props: {}, widgets: [
          { type: 'richtext', props: { align: 'left', markup: true }, text: {
            en: 'Every volume is cut into 64³-voxel bricks, packed, and streamed on demand according to what the camera is looking at. The browser never opens the whole file: exploration stays fluid well past several gigabytes, and quality climbs progressively instead of making you wait.\n\nRendering runs on a purpose-built WebGL2 ray-marcher. Each channel keeps its own colour, gamma and thresholds; oblique slices, measurements and the full session state can be exported and reopened exactly as they were.',
            fr: 'Chaque volume est découpé en briques de 64³ voxels, empaquetées puis chargées à la demande selon ce que la caméra regarde. Le navigateur n\'ouvre jamais le fichier entier : l\'exploration reste fluide bien au-delà de plusieurs gigaoctets, et la qualité monte progressivement plutôt que de faire attendre.\n\nLe rendu repose sur un ray-marcher WebGL2 écrit sur mesure. Chaque canal conserve sa couleur, son gamma et ses seuils ; les coupes obliques, les mesures et l\'état complet de la session peuvent être exportés puis rouverts à l\'identique.',
            es: 'Cada volumen se divide en ladrillos de 64³ vóxeles, se empaqueta y se carga bajo demanda según lo que mira la cámara. El navegador nunca abre el archivo completo: la exploración sigue siendo fluida mucho más allá de varios gigabytes y la calidad sube de forma progresiva en lugar de hacerte esperar.\n\nEl renderizado se apoya en un ray-marcher WebGL2 hecho a medida. Cada canal conserva su color, su gamma y sus umbrales; los cortes oblicuos, las mediciones y el estado completo de la sesión pueden exportarse y reabrirse tal cual.',
          } },
          { type: 'icon-list', props: {
            layout: 'v', gap: 14, iconColor: 'var(--color-primary)', iconSize: 18,
            items: [
              { icon: 'layers', href: '', text: { en: 'Progressive brick streaming — nothing to install', fr: 'Chargement progressif par briques — rien à installer', es: 'Carga progresiva por ladrillos: nada que instalar' } },
              { icon: 'box', href: '', text: { en: 'Real-time WebGL2 volume rendering', fr: 'Rendu volumique temps réel en WebGL2', es: 'Renderizado volumétrico en tiempo real con WebGL2' } },
              { icon: 'ruler', href: '', text: { en: 'Slices and measurements calibrated in micrometres', fr: 'Coupes et mesures calibrées en micromètres', es: 'Cortes y mediciones calibrados en micrómetros' } },
              { icon: 'share-2', href: '', text: { en: 'Exportable, reproducible session state', fr: 'État de session exportable et reproductible', es: 'Estado de sesión exportable y reproducible' } },
            ],
            style: { marginTop: 10 },
          } },
        ] },
      ]),

      // ── 4. Ways in ─────────────────────────────────────────────────────────
      SEC({ padY: 96, bg: 'var(--bg-surface)' }, [
        chapterLabel(
          { en: 'Explore', fr: 'Explorer', es: 'Explorar' },
          { en: 'Three ways into the data', fr: 'Trois façons d\'entrer dans les données', es: 'Tres formas de entrar en los datos' },
        ),
        { width: 8, props: {}, widgets: [
          { type: 'link-list', props: { items: [
            { icon: 'layout-grid', href: 'explorer.html',
              title: { en: 'Explorer', fr: 'Explorateur', es: 'Explorador' },
              desc: { en: 'Search and filter the whole catalogue — type, stage, markers.', fr: 'Chercher et filtrer dans tout le catalogue : type, stade, marqueurs.', es: 'Buscar y filtrar en todo el catálogo: tipo, etapa, marcadores.' } },
            { icon: 'columns-2', href: 'compare.html',
              title: { en: 'Compare', fr: 'Comparaison', es: 'Comparación' },
              desc: { en: 'Several datasets side by side, with linked camera and slicing.', fr: 'Plusieurs jeux de données côte à côte, caméra et coupes synchronisées.', es: 'Varios conjuntos de datos en paralelo, con cámara y cortes vinculados.' } },
            { icon: 'download', href: 'explorer.html',
              title: { en: 'Downloads', fr: 'Téléchargements', es: 'Descargas' },
              desc: { en: 'Original sources and web-ready files, dataset by dataset.', fr: 'Sources d\'origine et fichiers prêts pour le web, jeu par jeu.', es: 'Fuentes originales y archivos listos para la web, conjunto por conjunto.' } },
          ] } },
        ] },
      ]),

      // ── 5. The data ────────────────────────────────────────────────────────
      SEC({ padY: 96 }, [
        chapterLabel(
          { en: 'The data', fr: 'Les données', es: 'Los datos' },
          { en: 'Provenance and preparation', fr: 'Provenance et préparation', es: 'Procedencia y preparación' },
        ),
        { width: 8, props: {}, widgets: [
          { type: 'richtext', props: { align: 'left', markup: true }, text: {
            en: 'Volumes are never served raw. A preprocessing chain converts them offline into a multi-resolution pyramid; only the bricks needed for the current field of view then travel over the network.',
            fr: 'Les volumes ne sont jamais servis bruts. Une chaîne de prétraitement les convertit hors ligne en une pyramide multirésolution ; seules les briques utiles au champ de vision courant transitent ensuite par le réseau.',
            es: 'Los volúmenes nunca se sirven en bruto. Una cadena de preprocesamiento los convierte sin conexión en una pirámide multirresolución; después solo viajan por la red los ladrillos necesarios para el campo de visión actual.',
          } },
          { type: 'accordion', props: {
            single: true, firstOpen: false, itemBg: 'transparent', borderColor: 'var(--border-default)',
            style: { marginTop: 8 },
            items: [
              { q: { en: 'Which acquisition formats are accepted?', fr: 'Quels formats d\'acquisition sont acceptés ?', es: '¿Qué formatos de adquisición se aceptan?' },
                a: { en: 'Confocal HDF5/Imaris and TIFF stacks are converted upstream. The browser only ever receives WebP bricks together with a manifest describing dimensions, voxel size and channels.', fr: 'Les piles confocales HDF5/Imaris et TIFF sont converties en amont. Le navigateur ne reçoit que des briques WebP accompagnées d\'un manifeste décrivant dimensions, taille de voxel et canaux.', es: 'Las pilas confocales HDF5/Imaris y TIFF se convierten previamente. El navegador solo recibe ladrillos WebP acompañados de un manifiesto con dimensiones, tamaño de vóxel y canales.' } },
              { q: { en: 'What does preprocessing actually do?', fr: 'Que fait exactement le prétraitement ?', es: '¿Qué hace exactamente el preprocesamiento?' },
                a: { en: 'Corner-sampled background subtraction, window levelling, 8-bit reduction, slicing into 64³-voxel bricks, packing, and catalogue generation. Every step is versioned, and therefore reproducible.', fr: 'Soustraction de fond par échantillonnage des coins, fenêtrage, réduction en 8 bits, découpe en briques de 64³ voxels, empaquetage et génération du catalogue. Chaque étape est versionnée, donc reproductible.', es: 'Sustracción de fondo por muestreo de esquinas, ajuste de ventana, reducción a 8 bits, división en ladrillos de 64³ vóxeles, empaquetado y generación del catálogo. Cada etapa está versionada y, por tanto, es reproducible.' } },
              { q: { en: 'May I reuse these datasets?', fr: 'Puis-je réutiliser ces jeux de données ?', es: '¿Puedo reutilizar estos conjuntos de datos?' },
                a: { en: 'Reuse terms are set by the organisation publishing each dataset. When in doubt, get in touch before redistributing or republishing.', fr: 'Les conditions de réutilisation sont fixées par l\'organisation qui publie chaque jeu de données. En cas de doute, contactez-la avant toute rediffusion ou republication.', es: 'Las condiciones de reutilización las fija la organización que publica cada conjunto de datos. En caso de duda, contáctela antes de redistribuir o volver a publicar.' } },
            ],
          } },
        ] },
      ]),

      // ── 6. How to cite ─────────────────────────────────────────────────────
      SEC({ padY: 96, bg: 'var(--bg-surface)' }, [
        chapterLabel(
          { en: 'References', fr: 'Références', es: 'Referencias' },
          { en: 'Citing this work', fr: 'Citer ce travail', es: 'Citar este trabajo' },
          { en: 'Please cite both the platform and the source of the data.', fr: 'Merci de citer à la fois la plateforme et la source des données.', es: 'Cite tanto la plataforma como la fuente de los datos.' },
        ),
        { width: 8, props: {}, widgets: [
          { type: 'cite-block', props: {
            mono: true, copy: true, extraLabel: {}, extra: {},
            title: { en: 'The platform', fr: 'La plateforme', es: 'La plataforma' },
            text: {
              en: 'Surname, F. ({year}). {brand} [Computer software]. https://…',
              fr: 'Nom, P. ({year}). {brand} [Logiciel]. https://…',
              es: 'Apellido, N. ({year}). {brand} [Software]. https://…',
            },
          } },
          { type: 'cite-block', props: {
            mono: true, copy: true,
            title: { en: 'A dataset', fr: 'Un jeu de données', es: 'Un conjunto de datos' },
            text: {
              en: 'Surname, F. ({year}). Dataset title. Published through {brand}. https://…',
              fr: 'Nom, P. ({year}). Titre du jeu de données. Publié via {brand}. https://…',
              es: 'Apellido, N. ({year}). Título del conjunto de datos. Publicado a través de {brand}. https://…',
            },
            extraLabel: { en: 'BibTeX', fr: 'BibTeX', es: 'BibTeX' },
            // Doubled braces around a token keep the BibTeX field braces after
            // interpolation: "{{year}}" → "{2026}".
            extra: {
              en: '@misc{dataset,\n  author = {Surname, First},\n  title  = {Dataset title},\n  year   = {{year}},\n  note   = {Published through {brand}},\n  url    = {https://…}\n}',
              fr: '@misc{jeudedonnees,\n  author = {Nom, Prénom},\n  title  = {Titre du jeu de données},\n  year   = {{year}},\n  note   = {Publié via {brand}},\n  url    = {https://…}\n}',
              es: '@misc{conjunto,\n  author = {Apellido, Nombre},\n  title  = {Título del conjunto de datos},\n  year   = {{year}},\n  note   = {Publicado a través de {brand}},\n  url    = {https://…}\n}',
            },
            style: { marginTop: 14 },
          } },
        ] },
      ]),

      // ── 7. Contact ─────────────────────────────────────────────────────────
      SEC({ padY: 96 }, [
        chapterLabel(
          { en: 'Contact', fr: 'Contact', es: 'Contacto' },
          { en: 'Get in touch', fr: 'Écrire à l\'équipe', es: 'Escríbenos' },
        ),
        { width: 8, props: {}, widgets: [
          { type: 'richtext', props: { align: 'left', markup: true }, text: {
            en: 'For a metadata correction, a reuse request, or a question about a specific dataset, write to the team running this platform.',
            fr: 'Pour une correction de métadonnées, une demande de réutilisation ou une question sur un jeu de données précis, écrivez à l\'équipe qui édite cette plateforme.',
            es: 'Para una corrección de metadatos, una solicitud de reutilización o una pregunta sobre un conjunto de datos concreto, escriba al equipo que gestiona esta plataforma.',
          } },
          { type: 'spec-list', props: {
            labelWidth: 150, dividers: true,
            style: { marginTop: 10 },
            items: [
              { label: { en: 'Organisation', fr: 'Organisation', es: 'Organización' }, value: { en: '{org}', fr: '{org}', es: '{org}' }, href: '' },
              { label: { en: 'E-mail', fr: 'Courriel', es: 'Correo' }, value: { en: 'contact@example.org', fr: 'contact@example.org', es: 'contact@example.org' }, href: 'mailto:contact@example.org' },
              { label: { en: 'Address', fr: 'Adresse', es: 'Dirección' }, value: { en: 'Street, postcode, city, country', fr: 'Rue, code postal, ville, pays', es: 'Calle, código postal, ciudad, país' }, href: '' },
            ],
          } },
        ] },
      ]),
    ];
  }

  /**
   * Section array for a built-in page, or [] when the slug has no template.
   * A fresh, unshared object graph on every call (callers mutate it).
   */
  function build(slug) { return slug === 'about' ? about() : []; }

  return { build, has: (slug) => slug === 'about' };
})();
