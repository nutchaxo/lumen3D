# 21. Glossary

::: chapter-intro
- Terms are listed in **alphabetical order**. Each definition fits in one or two sentences.
- "→ chapter N" sends you to where the word is explained in detail.
- Names in square brackets, like [Studio]{.ui}, are the ones you see on screen.
:::

::: glossary
Atlas
: A large 3D texture in graphics memory where the bricks to display are stored, like the pigeonholes of a locker. → chapter 10

Bit depth
: The number of bits per value: 8 bits give 256 levels, 16 bits give 65,536. → chapter 4

Border (apron)
: An extra voxel around a brick, copied from its neighbours, so that filtering leaves no seam between two bricks. Format 4 bricks are 66³ for 64³ of useful data. → chapter 7

Brick
: A small cube of 64×64×64 voxels: the unit in which a volume is cut up and loaded. → chapter 7

Cache
: Memory where what has already been downloaded is kept so that it is not requested again. → chapter 10

Cell tracking
: Following each cell from frame to frame in a timelapse (trajectories, lineages, divisions). → chapter 8

Channel
: One image of the same object for a given fluorescence colour (for example DAPI, Pecam1, Sox2). → chapter 4

CSP (Content Security Policy)
: A rule given to the browser: run only the scripts that carry a single-use code (a nonce). → chapter 19

Data format
: The way a dataset is laid out on disk; numbered 1 to 4. The current format is 4. → chapters 7 and 14

Dilation
: An operation that thickens the areas of a mask by one or more pixels. → chapter 5

Ed25519 (signature)
: A digital signature method: a "wax seal" that only the publisher can apply and that anyone can verify. → chapter 19

ESS (Empty Space Skipping)
: Bricks that are almost entirely empty are neither stored nor traversed, which saves bytes and computation. → chapters 7 and 9

Exposure
: A global brightness setting applied to the display; it does not alter the data. → chapter 11

Gamma
: A setting that brightens or darkens the mid-tones without touching the extremes. → chapter 11

GPU
: The graphics card's processor, specialised in parallel computation; it runs the ray marching. → chapter 9

HDF5
: A scientific file format that stores large arrays of numbers, like a filing cabinet with drawers. Imaris files are HDF5 files. → chapter 4

Histogram
: A graph that counts how many voxels have each intensity value; it helps to set min and max. → chapter 11

.ims
: An Imaris file: an HDF5 container holding the channels, the resolution levels and the metadata of an acquisition. → chapter 4

index.bin
: The format 4 binary file that says which pack holds each brick; it replaces the large JSON manifest. → chapter 7

Kabsch (algorithm)
: A method that finds the rotation and shift that best align two point clouds; used to stabilise a timelapse. → chapter 8

LOD (level of detail) / level
: A version of the volume at a given resolution; level 0 is the finest. → chapter 6

Lossless WebP
: A compressed image format that returns the original values exactly; it stores the brick mosaics. → chapter 6

Lossy and lossless compression
: With lossy compression the file is smaller but the values are slightly changed; with lossless compression the original values are recovered exactly. Bricks are stored losslessly. → chapter 6

Manifest
: A file that describes the content of a dataset (levels, bricks, packs). → chapter 7

Mask
: A black-and-white image that says which pixels count (white) and which are discarded (black). → chapter 5

Median filter
: Replaces each value with the median of its neighbours: it removes isolated dots without blurring the edges. → chapter 5

Migration
: Updating an already published dataset to a more recent format, without going through the pipeline again. → chapter 14

MIP (maximum intensity projection)
: An image in which each pixel takes the strongest value met along an axis. → chapters 7 and 12

Morphological opening
: An erosion followed by a dilation: it erases small isolated dots from a mask and keeps the large shapes. → chapter 5

Mosaic
: Several small images pasted into one large one; a brick is stored as a mosaic of its slices. → chapter 7

Noise (background)
: Stray signal present even where there is nothing to see (scattered light, sensor electronics). → chapter 5

Nonce
: A random single-use code, drawn on every page load, that authorises the site's scripts. → chapter 19

Opacity
: The degree to which a structure absorbs light: 0 is transparent, 1 is opaque. → chapter 11

Pack
: A `.bin` file that gathers many bricks to limit the number of downloads. → chapter 7

Page table
: A table that says where each brick sits in the atlas, like a plan of the lockers. → chapter 10

Percentile
: The value below which a given percentage of measurements falls: the 99th percentile is exceeded by 1% of the values. → chapter 5

Pixel
: The smallest element of a 2D image. → chapter 4

Planes
: The `planes/` folder of format 2: one file per z plane of the native level, to read an XY slice without loading 64 planes. → chapter 14

Plugin
: An optional tool added to the viewer (measurement, capture, filter…); it is installed from the signed catalogue. → chapters 12 and 14

PNG
: A lossless image format; the planes of format 2 are 512×512 PNG tiles. → chapter 14

Pyramid
: A set of versions of the volume at ever coarser resolutions, stacked like the storeys of a pyramid. → chapter 6

Quaternion
: Four numbers that describe a 3D rotation without gimbal lock; they are used to remember an embryo's orientation. → chapter 12

Ray marching
: For each screen pixel, a ray is followed through the volume while colour and opacity are accumulated. → chapter 9

Sample (rendering)
: A value read at one point of the volume during ray marching. A ray takes hundreds of them. → chapter 9

Shader
: A small program run by the graphics card; the viewer's one does the ray marching. → chapter 9

Signature
: See Ed25519. → chapter 19

Staging
: A private area where imported files arrive before publication; it is never reachable by URL. → chapters 14 and 19

Streaming
: Progressive loading: what has arrived is displayed and completed continuously, without waiting for the whole file. → chapter 10

Studio
: The figure tool: cropping, annotations, scale bars and image export for publication. → chapter 12

Super-block
: A group of 4×4×4 neighbouring bricks that a pack stores together so that a region can be read in one piece. → chapter 7

Three.js
: A JavaScript library that simplifies 3D display in the browser. → chapter 2

Timelapse
: A series of acquisitions of the same specimen over time, each frame being a 3D volume. → chapter 4

Transfer function
: A rule that converts a volume value into a colour and an opacity. → chapter 11

Trilinear interpolation
: Estimating a value between voxels by blending the eight neighbours, which gives a smooth image. → chapter 9

Voxel
: A pixel in 3D: a small cube with an intensity value. Its real size (in µm) is the calibration. → chapter 4

VRAM
: The graphics card's memory. Its budget limits the size of atlas the viewer can use. → chapter 10

WebGL2
: A browser technology that gives access to the graphics card, notably to 3D textures. → chapter 9

Windowing
: Choosing the min and max values displayed: below, black; above, full intensity. → chapter 11

Worker (Web Worker)
: A background process of the browser: it decodes and computes without freezing the screen. → chapter 10
:::
