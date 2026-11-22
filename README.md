# Vanilla Data Grid

A dependency-free data grid component in plain JavaScript. It supports sorting, search, pagination, inline add and delete, CSV/JSON export, and light/dark themes.

**Live demo:** https://gridtable2023.netlify.app

---

## Features

- Column sorting (ascending and descending toggle)
- Search across all columns
- Pagination with page-size selection and windowed page numbers
- Add and delete rows
- **Export to CSV and JSON**
- Light and dark theme toggle
- Row selection and per-field validation rules
- Configurable through a single `config` object, with an ES module export and a `window.ModernGrid` global

## Usage

```js
import { ModernGrid } from './modern-grid.js';

new ModernGrid('#grid-container', {
  columns: [
    { field: 'id', title: 'ID' },
    { field: 'name', title: 'Name' },
  ],
  data,
  pageSize: 10,
});
```

## Architecture

There are two implementations, both kept on purpose:

- `modern-grid.js`: a single class-based component (current)
- `model/ view/ controller/`: the original MVC version, which shows how the code moved from MVC to a self-contained component

## Getting started

```bash
npm install
npm run dev
```

## Roadmap

- Virtualised rows for large datasets
- Keyboard navigation and ARIA grid roles
- Publish as an npm package
