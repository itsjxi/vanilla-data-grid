# Vanilla Data Grid

[![CI](https://github.com/itsjxi/vanilla-data-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/itsjxi/vanilla-data-grid/actions/workflows/ci.yml)

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

## How it works

- **One view pipeline.** Every change (search, sort, add, delete, edit) goes through `applyView()`, which recomputes the visible rows as data, then search, then sort. A filter or sort is never silently lost.
- **Selection by row identity.** Selected rows are tracked as objects, not array indexes. Selections survive sorting, filtering and deletes; identical rows stay distinct; and *select all* only selects rows the user can see.
- **Safe rendering.** Cell values are HTML-escaped before they reach `innerHTML`.
- **Smart sorting.** `compareValues()` sorts currency and numeric strings numerically (`$90 < $1,200`) and text with locale-aware natural ordering (`Item 2 < item 10`).

## Testing

```bash
npm test   # Vitest + jsdom
```

The 13 tests drive the real DOM. They cover typing into search, sort being kept while filtering, select-all and delete with an active search, selections after deletes, duplicate rows, pagination, HTML escaping and CSV export. CI runs them and a build on every push.

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
