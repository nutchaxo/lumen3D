# Changelog v1.56.2 (Web Platform)

## [FIXED]

- **The Studio keeps its panels beside the figure on a laptop screen**: under 980 CSS px (a 1920 px screen at 200 % scaling, or a window that is not full width) the Studio stacked the tools/layers panel and the properties/channels panel under the canvas, each squeezed to 30 % of the height. Now the panels only get narrower down to 1100 px (228 px and 272 px instead of 268 px and 320 px from 1280 px). From 1100 px to 721 px they share one column on the right, tools and layers above, properties and channels below, and each scrolls on its own. Only a phone-sized viewport (720 px or less) stacks them under the figure.
- **The stacked Studio no longer draws the canvas over its panels**: on a narrow viewport the canvas kept its minimum height of 42 % of the window while its grid row shrank, so the panels below sat on top of the figure and of the native-loading box. The row now keeps that minimum, and the Studio scrolls instead.
