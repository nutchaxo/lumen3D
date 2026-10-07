# 21. Glossary

::: chapter-intro
- Terms are listed in **alphabetical order**. Each definition fits in one or two sentences.
- "→ chapter N" sends you to where the word is explained in detail.
- Names in square brackets, like [Studio]{.ui}, are the ones you see on screen.
:::

::: glossary
Apron (border)
: An extra voxel around a brick, copied from its neighbours, so that filtering leaves no seam between two bricks. Format 4 bricks are 66³ for 64³ of useful data. → chapter 7

Atlas
: A large 3D texture in graphics memory where the bricks to display are stored, like the pigeonholes of a locker. → chapter 10

Atomic
: Said of an operation that succeeds in full or not at all, with no intermediate state visible. Publishing a dataset is atomic. → chapters 8 and 17

Background noise
: Stray signal present even where there is nothing to see (scattered light, sensor electronics). → chapter 5

Batch (of bricks)
: A set of bricks requested together from the loader, which handles its cancellation and returns a summary (delivered, failed, skipped). → chapter 10

Bit depth
: The number of bits per value: 8 bits give 256 levels, 16 bits give 65,536. → chapter 4

Blue-green (deployment)
: An update method: the new version is prepared next to the old one, tested, then swapped in; the old one stays available for a rollback. → chapter 18

Bounding box
: The parallelepiped that surrounds the whole volume. A click that reaches only this box, with no visible structure beneath, is not a valid measurement. → chapter 12

Brick
: A small cube of 64×64×64 voxels: the unit in which a volume is cut up and loaded. → chapter 7

Cache
: Memory where what has already been downloaded is kept so that it is not requested again. → chapter 10

Calibration (physical)
: The real size of a voxel, in micrometres, in each direction. Without it, the scale bar and measurements do not exist. → chapters 4 and 9

Catalogue
: Two meanings to tell apart: the list of the site's datasets, generated on demand from the files, and the signed plugin catalogue, from which tools are installed. → chapters 3 and 15

Cell tracking
: Following each cell from frame to frame in a time-lapse (trajectories, lineages, divisions). → chapter 8

Channel
: One image of the same object for a given fluorescence colour (for example DAPI, Pecam1, Sox2). → chapter 4

Confocal (microscope)
: A microscope that records only the light coming from a very thin plane of the specimen, plane after plane; the stack of planes forms the volume. → chapter 4

Context (page or panel)
: The situation a page runs in: alone, or embedded as a panel (Compare, split view). A plugin loads in a panel only if it has declared it can. → chapter 15

CSP (Content Security Policy)
: A rule given to the browser: run only scripts that carry a single-use code (nonce) and come from the site itself. → chapter 19

CSRF (anti-forgery token)
: An attack in which a third-party site makes a request without your knowledge, from your session. A secret token, required for every change, prevents it. → chapter 19

DAPI, Pecam1, Sox2
: The three channels of the demonstration dataset: DAPI stains DNA (the nuclei), Pecam1 marks the vessels, Sox2 the neural tissue. → chapter 4

Data format
: The way a dataset is laid out on disk; numbered 1 to 4. The current format is 4. → chapters 7 and 17

Deconvolution
: A calculation that tries to undo the blur of the optics to sharpen the image. Lumen3D does not do it. → chapter 20

Dilation
: An operation that thickens the areas of a mask by one or more pixels. → chapter 5

Ed25519 (signature)
: A digital signature method: a "wax seal" that only the publisher can apply and that anyone can verify. → chapter 19

Embryonic day (E8.5)
: The age of a mouse embryo: E8.5 means eight and a half days after fertilisation. The platform reads the stage from the file name (E8-5 means E8.5). → chapter 8

ESS (Empty Space Skipping)
: Bricks whose voxels are all 0 are neither stored nor traversed, which saves bytes and computation. In format 4 the rule is exact (a single non-zero voxel is enough to keep the brick); before, an occupancy threshold of 0.05 % also discarded nearly empty bricks. → chapters 7 and 9

Executor
: Whoever does the work of a data conversion: the browser or the server. It can change along the way, the journal is shared. → chapter 17

Exposure
: A global brightness setting applied to the display; it does not alter the data. → chapter 11

Finalisation
: The last step of a data conversion: the new files replace the old ones in a single move, then the format number is updated. → chapter 17

Fingerprint (hash, SHA-256)
: A short code computed from a file's content: if a single byte changes, the fingerprint changes. It is used to verify a download, a plugin, an import chunk. → chapters 15 and 19

Fluorophore
: A molecule that absorbs light and re-emits it in another colour; it is what labels a structure in the sample. One channel corresponds to one fluorophore. → chapter 4

Gamma
: A setting that brightens or darkens the mid-tones without touching the extremes. → chapter 11

GPU
: The graphics card's processor, specialised in parallel computing; it runs the ray marching. → chapter 9

HDF5
: A scientific file format that stores large arrays of numbers, like a filing cabinet with drawers. Imaris files are one. → chapter 4

Health probe
: A small request (`/api/health`) that checks that the server answers with the right version after an update. → chapter 18

Histogram
: A graph that counts how many voxels have each intensity value; it helps set min and max. → chapter 11

i18n (internationalisation)
: The mechanism that lets the interface be shown in several languages (English, French, Spanish, Dutch…) and lets more be added. → chapter 16

Idempotent
: Said of an operation that can be repeated without harm: the result is the same as doing it once. This is what makes resumptions safe. → chapter 17

.ims file
: An Imaris file: an HDF5 container that holds the channels, the resolution levels and the metadata of an acquisition. → chapter 4

index.bin
: A format 4 binary file that says which pack holds each brick; it replaces the large JSON manifest. → chapter 7

Intensity
: The value of a voxel: how much light was measured at that spot. In the viewer it is relative (0 to 255), not calibrated. → chapters 4 and 11

Journal
: A file kept up to date during a long operation (import, conversion): it notes what is done, which makes it possible to resume after an interruption. → chapter 17

Kabsch (algorithm)
: A method that finds the rotation and shift that best align two clouds of points; used to stabilise a time-lapse. → chapter 8

Lineage, mitosis, fusion
: In cell tracking: the lineage is the sequence of a cell and its descendants; mitosis is a division into two cells; fusion joins two cells into one. → chapter 12

LOD (level of detail) / level
: A version of the volume at a given resolution; level 0 is the finest. → chapter 6

LOD0
: The finest level of detail: the native resolution of the acquisition. → chapter 6

Lossless WebP
: A compressed image format that restores the original values exactly; it stores the brick mosaics. → chapter 6

Lossy, lossless compression
: With loss, the file is smaller but the values are slightly modified; lossless, the original values are recovered exactly. Bricks are stored losslessly. → chapter 6

Manifest
: A file that describes the content of a dataset (levels, bricks, packs). → chapter 7

Mask
: A black-and-white image that says which pixels count (white) and which are discarded (black). → chapter 5

Median filter
: Replaces each value with the median of its neighbours: it removes isolated spots without blurring the edges. → chapter 5

Migration
: Updating an already published dataset to a more recent format, without going through the pipeline again. → chapter 17

MIP (maximum intensity projection)
: An image where each pixel takes the strongest value met along an axis. → chapters 7 and 12

Morphological opening
: Erosion followed by a dilation: it erases small isolated dots of a mask and keeps the large shapes. → chapter 5

Mosaic
: Several small images pasted into one large one; a brick is stored as a mosaic of its slices. → chapter 7

Nonce
: A random single-use code, drawn at each page load, which authorises the site's scripts. → chapter 19

Opacity
: A factor applied to a channel's intensity: 0 makes it invisible, 1 leaves it at full intensity. It is not the tissue's physical absorption, which exists (as a constant) only in Natural fluorescence mode. → chapter 11

Optical section, focal plane
: The image of a thin slice of the specimen, sharp at a given depth. The section thickness is the distance between two planes (3.0 µm in the demonstration dataset). → chapter 4

Pack
: A `.bin` file that groups many bricks to limit the number of downloads. → chapter 7

Page table
: A table that says where each brick is in the atlas, like a plan of the lockers. → chapter 10

PBKDF2
: A method that turns a password into a fingerprint that is deliberately slow to compute (600,000 rounds), to discourage mass guessing. → chapter 19

Percentile
: The value below which a given percentage of the measurements lie: the 99th percentile is exceeded by 1 % of the values. → chapter 5

Photobleaching
: Progressive loss of fluorescence of a sample lit for a long time. In a time series, the signal then drops without the structure changing. → chapter 5

Pivot
: The moment of the update when a supervisor replaces the old site folder with the new one, restarts the server and checks that it answers; otherwise it goes back. → chapter 18

Pixel
: The smallest element of a 2D image. → chapter 4

Planes
: The `planes/` folder of format 2: one file per z plane of the native level, to read an XY slice without loading 64 planes. → chapter 7 (and 17)

Plugin
: An optional tool added to the viewer (measurement, capture, filter…); it is installed from the signed catalogue. → chapters 12 and 15

PNG
: A lossless image format; the planes of format 2 are 512×512 PNG tiles. → chapter 7 (and 17)

Poisson noise
: Random variation of a weak signal, due to the limited number of photons received: the weaker the signal, the grainier it looks. Camera noise is added to it. → chapter 5

PSF (point spread function)
: The blurred shape that optics give to a point of light. Deconvolution tries to undo it; Lumen3D does not correct it. → chapter 20

Pyramid
: A set of versions of the volume at increasingly coarse resolutions, stacked like the floors of a pyramid. → chapter 6

Quaternion
: Four numbers that describe a 3D rotation without gimbal lock; they are used to store an embryo's orientation. → chapter 12

Ray marching
: For each pixel of the screen, a ray is followed through the volume, accumulating colour and opacity. → chapter 9

Registration
: Aligning the successive frames of a time-lapse to compensate for the embryo's movement (Kabsch algorithm). → chapter 8

Rollback
: Automatic return to the old version when the new one does not start. The Python server does it; PHP hosting does not. → chapters 18 and 19

Sample (rendering)
: A value read at one point of the volume during ray marching. A ray takes hundreds of them. → chapter 9

Sandbox
: A cage in which a third-party plugin runs: it sees neither the page nor your cookies, and can ask only for what it has explicitly been allowed. → chapter 15

Saturation
: A value that exceeds the maximum representable and is clipped. The pipeline deliberately saturates the brightest 0.1 % of voxels (`sig_max`). → chapter 5

Shader
: A small program run by the graphics card; the viewer's does the ray marching. → chapter 9

Signature
: See Ed25519. → chapter 19

Specimen
: The name the institution gives to what it observes (embryo, organ…); it changes throughout the interfaces. → chapter 16

SRI (Subresource Integrity)
: The expected fingerprint of a script or style sheet, written into the page: if the loaded file differs, the browser refuses it. → chapter 19

Staging
: A private area where imported files arrive before publication; it is never reachable by URL. → chapters 17 and 19

Stereomicroscope
: A low-magnification microscope that gives a colour image of the whole embryo; it produces the 2D-type photographs. → chapter 12

Streaming
: Progressive loading: what has arrived is displayed and completed continuously, without waiting for the whole file. → chapter 10

Studio
: The figure tool: cropping, annotations, scale bars and image export for publication. → chapter 12

Super-block
: A group of 4×4×4 neighbouring bricks that a pack stores together so that a region is read in one piece. → chapter 7

Three.js
: A JavaScript library that simplifies 3D display in the browser. → chapter 2

Tier
: A priority group of an import: the files that make a dataset openable (metadata, coarsest level) go first. → chapter 17

Time-lapse
: A series of acquisitions of the same specimen over time, each frame being a 3D volume. → chapter 4

Token
: A small code that proves a right: the anti-forgery (CSRF) token of a change, or a "token bucket" that limits the number of requests admitted per second. → chapter 19

Transfer function
: A rule that converts a volume value into colour and opacity. In Lumen3D, it is the chain of window, gamma, opacity and colour in the channel panel; chapter 11 describes it without using this term. → chapter 11

Trilinear interpolation
: Estimating a value between voxels by blending the eight neighbours, which gives a smooth image. → chapter 9

Unit (of conversion)
: A piece of work in a data conversion: a layer of 64 planes, of one channel, for one 512×512 tile. → chapter 17

Voxel
: A pixel in 3D: a small cube with an intensity value. Its real size (in µm) is the calibration. → chapter 4

VRAM
: Graphics-card memory. Its budget limits the atlas size the viewer can use. → chapter 10

WebGL context (loss of)
: A reset of the graphics card by the browser or the driver: the textures disappear. The viewer reloads the view with a reduced memory budget. → chapter 19

WebGL2
: A browser technology that gives access to the graphics card, notably to 3D textures. → chapter 9

White label
: The platform's ability to take on the name, colours, texts and data types of the institution that hosts it, without writing code. → chapter 16

Widget
: A block of content on a page built in the editor (text, image, button…), placed in a column of a section. → chapter 16

Windowing
: Choosing the displayed min and max values: below, black; above, full intensity. → chapter 11

Worker (Web Worker)
: A background process of the browser: it decodes and computes without freezing the screen. → chapter 10

X-gal
: A stain that turns cells expressing a reporter gene blue; the 2D viewer can isolate this stain. → chapter 12

Z-stack
: The set of successive planes of a volume, stacked along the Z axis. → chapter 12

:::
