# Continental GTC Speed — scroll-driven film site

Open `index.html` through any static server (e.g. `python3 -m http.server`) — not by double-clicking, so the frames load reliably.
Needs internet for three.js r128 / GSAP 3.12.5 (cdnjs) and Google Fonts.

- `assets/frames/` WebP frames (12.5 fps, 1920x1080) · `assets/logo.png` cut from the film's end card
- Edit chapter copy + timing in `index.html` (`data-start` / `data-end` = fraction of the scroll)
- Edit frame count / contact email at the top of `js/main.js`
- Prices, phone, email and address are placeholders — replace before publishing
