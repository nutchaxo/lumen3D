# Changelog v1.67.1 (Web Platform)

## [CHANGED]

- **Quality picker as two lists**: on a format-5 dataset the quality control is now two scrolling lists instead of a table of levels × compressions. *Resolution* lists the levels finest first, each with its dimensions and the GPU memory it takes; *Quality* lists the five compressions for the chosen resolution, each with the size to download. Picking in one list keeps the other.
- **Quality tiers named Max, Extra, High, Medium, Low**: the compressions are shown as Max (lossless), Extra (±2 grey levels), High (±4 grey levels), Medium (WebP 80) and Low (WebP 50), in the picker, in the resolution select and in the guide. The on-disk codec names stay in the guide.
- **The colours and sizes say what they mean**: the colour of a resolution is the GPU memory of that level, the same for every quality because the card holds the decompressed voxels; every size is the total of all channels. The old legend did not say either, and the old table gave a time only after a download had been measured here.

## [ADDED]

- **How to choose guide**: a *How to choose?* button opens a dialog with every resolution × quality combination (size to download, download time, GPU memory), the GPU colour code with the current budget, what each quality stores and how big it is on this dataset (measured from the manifest, e.g. 60–82 % of Max for Extra), and advice. A cell of the table loads that combination and closes the guide.
- **Download speed for the guide's times**: the times are given at the speed measured on the page, or at a stated link speed of 5, 20 or 100 Mb/s. The picker still shows a time only once a download was measured here.
- **Summary when the GPU refuses the chosen resolution**: the summary line names the level actually shown, so the picker never claims a resolution the viewer is not displaying.
