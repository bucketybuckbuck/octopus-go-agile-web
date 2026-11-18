# Octopus Go Agile (web)

A browser port of the Android app [bucketybuckbuck/android](https://github.com/bucketybuckbuck/android)
(`com.jamsim.goagile`): compare what your electricity would cost on Octopus **Agile** vs Octopus **Go**
using your real smart meter readings.

It's a static site, with no build step and no backend. Open it through any static web server:

```bash
python -m http.server 8765 --directory webapp
```

Then go to http://localhost:8765.

Live at https://bucketybuckbuck.github.io/octopus-go-agile-web/ (GitHub Pages, served from `main`).

## Pages (same as the Android app)

| Android screen | Web |
|---|---|
| Home: price list, now highlight, shading, avg/min/max, yesterday's graph | `#home`, plus a price chart |
| History: billing month of daily graphs and a summary pie chart, export switch, load shift on tap | `#history` (summary uses stat tiles and a daily bar chart) |
| Gas: daily gas usage and cost | `#gas` |
| Settings | `#settings` (saves automatically) |
| About | `#about` |

## Setup

Enter your Octopus **API key** and **account number** in Settings and press **Connect**. The app reads
your account from the Octopus API and fills in everything else: import and export MPANs, meter serials
(it uses the meter that actually has readings), region, current tariffs, the fixed export rate, and your gas
meter and gas tariff. You can still enter the details by hand under "Meter details".

## Differences from the Android version

- **Set up from your account number** instead of typing in MPAN, serial and region.
- **Gas costs use your real gas tariff** (unit rate and standing charge) once connected.
- **History uses your tariff history.** Each day is costed on the tariff you were actually on ("You paid"),
  next to Agile and Go. Agile and Go use the version that was on sale on that date (or yours, if you were on it),
  and days you switched tariff are marked.
- **Gas readings in m³ or kWh are detected automatically** by comparing a year of readings with Octopus's annual
  estimate; the volume-correction and calorific-value settings are gone (standard values are used).
- **Price list options are on by default**, with low/high thresholds worked out from the last week of Agile prices.

- **Go rates come from the API.** The Android app hard-coded the Go and Go Faster windows and
  used old product codes (`AGILE-18-02-21`, `GO-18-06-12`, both retired). The web version reads Go's
  time-banded rates and real standing charges for both tariffs. Product codes can be set in Settings
  ("Use latest Octopus products" fills them in). The Go Faster options are gone because the API
  rates cover them.
- **Load shift** moves `consumption − baseload` into a free cheap slot, *adding* to what was already
  used there. The original replaced the target slot's usage instead.
- **Region detection** from your MPAN.
- The Firebase analytics and ads have been removed.

## Privacy

Your API key and meter details are stored in `localStorage` and sent only to `api.octopus.energy`
(the API allows cross-origin requests). Readings are cached in `localStorage`: data older than two
days is kept, and recent data is refetched after 30 minutes.
