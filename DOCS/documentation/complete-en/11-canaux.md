# 11. Colours, contrast and histograms

::: chapter-intro
- Every channel follows the same chain of settings: **invisible floor → min / max window → gamma → opacity → colour**, then the channels are combined.
- The **histogram** shows how the 256 grey levels are distributed; its three handles set the window and the gamma.
- Grey levels are **relative** to one dataset: they are not calibrated fluorescence intensities.
:::

## 11.1 The processing chain of a channel

Each voxel is stored as one **byte** (a number from 0 to 255). Before becoming a coloured pixel, it goes through seven steps. Five are within your reach; only one is hidden.

![The journey of a value: from the stored byte to the pixel colour.](img-en/ch11/chaine.svg){width=100%}

| Step | Who decides? | Where to set it |
|---|---|---|
| Floor | automatic (histogram) | nowhere |
| Min / max window | you | left and right handles |
| Gamma | you | middle handle |
| Opacity | you | droplet button (3 values) |
| Colour | you | colour swatch |
| Exposure | you | [Visibility (exposure)]{.ui} slider, global |

## 11.2 The hidden step: the background floor

Before you touch any setting, the viewer **flattens the background**: every value less than or equal to a threshold, the **floor**, becomes **0**, and the remaining values are **stretched** to fill the whole 0–255 scale.

![The effect of a floor of 26 (the estimated real value for the DAPI channel of the E9.5 dataset).](img-en/ch11/plancher.png){width=60%}

::: tech
The floor `f` is estimated from the dataset's histogram: we look for the first level where the cumulative count reaches **bin 0 + 20% of the non-zero voxels**, take the upper edge of that bin, add 2 and clamp the result between **6 and 48**. Then: `value' = 0` if `value ≤ f`, otherwise `round((value − f) × 255 / (255 − f))`.
:::

::: example
Floor of 26 (DAPI): a voxel stored at **120** becomes (120 − 26) × 255 / 229 ≈ **105**; a voxel at 20 becomes **0**. For the E9.5 dataset the estimated floors are 26 (DAPI), 10 (Pecam1) and 22 (Sox2).
:::

::: note
The values you read on the handles (Min 0, Max 255…) are already **after** this floor. You never see it, but it explains why the background is so clean.
:::

## 11.3 The min / max window and gamma

The **window** chooses which portion of the scale goes "from black to full brightness". Values below **Min** become black, those above **Max** saturate, and between the two the transition is **linear**.

**Gamma** then bends this scale: a gamma below 1 **brightens** the weak tones (useful for faint signals), a gamma above 1 **darkens** them.

![On the left, the window min 20 / max 220; on the right, the effect of gamma 0.5 / 1 / 2.](img-en/ch11/courbes.png){width=100%}

::: example
A voxel of value **120**, with Min = 20, Max = 220, gamma = 0.5 and opacity = 70%:

1. Window: (120 − 20) / (220 − 20) = **0.5**
2. Gamma: 0.5 to the power 0.5 = **0.707**
3. Opacity: 0.707 × 0.7 = **0.495**
4. Colour: on a green channel (0; 1; 0), the voxel contributes (0; **0.495**; 0), before exposure.
:::

### The middle handle

The middle handle does not set the gamma directly: it designates the level (**within the window**) that should be displayed at **50%**. The viewer deduces the gamma from it, clamped between **0.18 and 5.5**:

`gamma = ln 0.5 / ln m`, where `m` is the relative position of the handle between Min and Max.

::: example
Handle at a quarter of the window (m = 0.25): gamma = ln 0.5 / ln 0.25 = **0.5**. With Min = 20 and Max = 220, this quarter corresponds to the value 20 + 0.25 × 200 = **70**: a value of 70 is displayed at 50%. Handle in the middle (m = 0.5): gamma = 1.
:::

## 11.4 A channel's panel

Each channel has its own card in the [Channels]{.ui} panel. The summary line (for example `0-255 | gamma 1.00 | 70%`) recalls the window, gamma and opacity even when the card is collapsed.

![An expanded channel card (DAPI, E9.5 demo dataset).](img-en/ch11/panneau-canaux.png){.shot width=100%}

*(numbers: see the legend below.)*

::: legend
| n | what it is |
|---|---|
| 1 | checkbox (show / hide the channel) and channel name, editable |
| 2 | buttons: [Solo channel]{.ui}, opacity (droplet), colour (swatch) |
| 3 | histogram, with the three handles: Min (left), gamma (middle), Max (right) |
| 4 | values read out: Min, Gamma, Max |
| 5 | quick-setting buttons: Auto, Soft, Contrast, Reset (see below) |
| 6 | [Gaussian blur σ]{.ui} slider (section 11.8) |
:::

## 11.5 Histograms

A **histogram** counts how many voxels have each value. The panel's histogram has **64 columns** (4 grey levels per column).

- It is computed **by the pipeline**, on the **coarsest level** of the pyramid, and saved in the manifest. The browser does not recompute it.
- It covers **all** voxels, background included: that is why the first column is huge (86 to 97% of the voxels of the E9.5 dataset).
- In a **time series**, each timepoint has its own histogram; the panel follows it when you change frame.
- It represents the **stored bytes** (before the floor and the window).

![The real histograms of the three channels of the E9.5 demo dataset. Top: the raw counts. Bottom: what the panel draws. The dotted lines mark the range chosen by [Auto]{.ui}.](img-en/ch11/histogrammes.png){width=100%}

### How the panel draws the histogram

A giant column at level 0 would crush everything else. The panel therefore applies three rules:

- **linear** scale, normalised by the tallest column;
- the **lowest 4% of columns** (the first 3 out of 64) are **capped at 1.35 times** the tallest column that follows them;
- "comb gaps" (a column below 20% of both its neighbours) are filled with the average of its neighbours, to hide a WebP decoding artefact.

::: note
The [Ignore low]{.ui} checkbox changes only the **drawing**: it multiplies the displayed columns by (i / 63)² to flatten the background bump. It **does not modify the image**.
:::

## 11.6 The quick-setting buttons

The buttons under the histogram set Min, Max and the midpoint in one go. They are called **Auto**, **Soft**, **Contrast** and **Reset** in the panel.

| Button | Min | Max | Resulting gamma |
|---|---|---|---|
| **Auto** | 0.5th percentile | 99.5th percentile | 1 (middle of the window) |
| **Soft** | 5 | 240 | 0.83 |
| **Contrast** | 20 | 209 | 1.22 |
| **Reset** | 0 | 255 | 1 |

::: tech
**Auto** walks through the histogram (64 columns): Min = last column whose cumulative count stays ≤ 0.5% of the voxels, Max = end of the last column whose cumulative count stays ≤ 99.5%. Without a histogram: Min 0.01 and Max 0.98 (out of 1). The presets are expressed on the 0–1 scale: Soft = 0.02 / 0.94 with midpoint at 0.42; Contrast = 0.08 / 0.82 with midpoint at 0.5; Reset = 0 / 1 / 0.5.
:::

::: example
**Auto** on the E9.5 dataset gives Max = 80 for DAPI, 36 for Pecam1 and 92 for Sox2, and Min = 0: since 86 to 97% of the voxels are background, the lowest 0.5% falls entirely within the first column. [Reset]{.ui} puts back 0 / 255.
:::

::: warning
Auto reflects the **distribution of all voxels**, background included. On a rare signal, it may place Max very low: the image then saturates, deliberately. Keep an eye on the histogram and adjust the handles by hand if needed.
:::

## 11.7 Colours, opacity, exposure, solo

### Colour: an addition of lights

A channel's colour is a simple **RGB multiplier**. Channels are **added together**, like spotlights: where two channels are strong, the colours mix, and anything above 1 is clipped on screen.

![Additive mixing: green + magenta gives white.](img-en/ch11/melange.svg){width=95%}

- The picker offers **27 colours**: three rows (vivid, light, dark) of nine hues.
- By default (when the metadata gives no colour): green, light blue, magenta, red.
- The header's menu of **colour-vision deficiency simulations** applies a filter to the whole screen: it is for checking that a figure stays legible, and does not change the data.

::: tip
Avoid red and green side by side for figures meant for a wide audience: choose green and magenta instead, which remain distinct for most deficiencies.
:::

### Opacity, exposure, solo

- **Opacity**: the droplet button cycles through **70%, 42%, 100%**. It is an intensity multiplier (0.7; 0.42; 1), not a physical absorption.
- **Exposure**: the [Visibility (exposure)]{.ui} slider (from 20 to 500%, i.e. ×0.2 to ×5) multiplies the final colour; in the natural mode, it multiplies the emission.
- **Solo**: [Solo channel]{.ui} shows only that channel; a second click ([Show all channels]{.ui}) restores the previous state.
- A dataset with **more than 4 channels** shows only **4** (a limit of the graphics texture).

## 11.8 The Gaussian blur

The [Gaussian blur σ]{.ui} slider (from 0 to 5, in steps of 0.1) smooths the noise of **one channel**. The effect is applied **when you release** the slider; setting σ back to 0 restores the original channel. The setting changes only the display.

![Plane by plane, with several workers; two calculation methods depending on σ.](img-en/ch11/flou.svg){width=100%}

::: remember
- **2D in the plane**: each Z plane is blurred separately, never from one plane to another.
- σ is in **voxels of the displayed level**.
- Computed by a pool of **up to 4 workers**, outside the page; a bubble indicates that the calculation is in progress.
:::

:::: cols
::: col
![Sox2 channel alone, σ = 0.](img-en/ch11/flou-avant.png){.shot}
:::
::: col
![Same area, σ = 2.0.](img-en/ch11/flou-apres.png){.shot}
:::
::::

::: warning
The blur is only available if the displayed level fits in **a single dense texture**. For a large level stored in an atlas, the slider is greyed out with the message: "Not available at this quality (sparse brick atlas): choose a lower quality to use the blur." Using the blur also disables the [Zoom detail]{.ui} mode (chapter 10).
:::

## 11.9 A safeguard: what the grey levels mean

::: warning
**The grey levels displayed are relative, not calibrated.** The pipeline brought the original intensities (12 or 16 bits) down to 0–255, between an estimated background (99th percentile of the volume's corners) and a maximum signal (99.9th percentile); the viewer adds its floor on top. A value of 120 therefore corresponds to **no number of photons**.
:::

- Comparing **two channels** of the same dataset is delicate: each is stretched over its own scale.
- Comparing **two datasets** by their grey levels is not valid, even with identical settings.
- In a **time series**, the same window is shared by all the timepoints of a channel: intensity variations over time remain comparable with one another.
- For a **quantitative measurement**, go back to the original data (the Imaris file).
