<img src="admin/mspa.png" width="200" />

# ioBroker.mspa

[![NPM version](https://img.shields.io/npm/v/iobroker.mspa.svg)](https://www.npmjs.com/package/iobroker.mspa)
[![Downloads](https://img.shields.io/npm/dm/iobroker.mspa.svg)](https://www.npmjs.com/package/iobroker.mspa)
![Number of Installations](https://iobroker.live/badges/mspa-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/mspa-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.mspa.png?downloads=true)](https://nodei.co/npm/iobroker.mspa/)

**Tests:**  
![Test and Release](https://github.com/arteck/ioBroker.mspa/workflows/Test%20and%20Release/badge.svg)
![CodeQL](https://github.com/arteck/ioBroker.mspa/actions/workflows/codeql.yml/badge.svg?branch=main)

## mspa adapter for ioBroker
Controls MSpa hot tubs via the MSpa Cloud API

## Features

- 🌡️ Read/set water temperature & target temperature (20–40 °C, 0.5 °C steps)
- 🔥 Turn heating, filter, bubble, jet, ozone and UVC on/off
- 📊 Automatic heating & cooling rate calculation (°C/h, moving average)
- ⚡ Power failure detection with optional state restoration
- 🌍 3 server regions: Europe (ROW), USA, China
- 🔒 Rate limiter (max. 2.5 requests/second)
- 🚀 Rapid polling after commands (1-second interval for 15 s)

## Changelog
### 0.0.1 (2026-04-16)
- (arteck) first release


## License

MIT License

Copyright (c) 2026 Arthur Rupp <arteck@outlook.com>,

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
