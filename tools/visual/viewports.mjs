// Viewport matrix for visual self-review.
//
// Covers the resolutions + aspect ratios that matter for responsive UI/UX:
// ultrawide, standard desktop, laptop, tablet (both orientations), and phones.
// Extend this list as the product gains real screens — it's the single source
// of truth for what gets screenshotted.

export const VIEWPORTS = [
  { name: "ultrawide-1440p", width: 2560, height: 1080, note: "21:9 ultrawide" },
  { name: "desktop-1080p", width: 1920, height: 1080, note: "16:9 standard desktop" },
  { name: "laptop-1440", width: 1440, height: 900, note: "16:10 laptop" },
  { name: "tablet-landscape", width: 1024, height: 768, note: "4:3 tablet landscape" },
  { name: "tablet-portrait", width: 768, height: 1024, note: "3:4 tablet portrait" },
  { name: "mobile-390", width: 390, height: 844, note: "~19.5:9 modern phone" },
  { name: "mobile-360", width: 360, height: 640, note: "16:9 small/older phone" },
];
