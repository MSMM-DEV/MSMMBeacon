// A tiny, module-level snapshot of the currently-mounted table's chrome
// (sort, search, column order, widths, hidden cols, processed rows).
//
// Why not Context? Export is triggered from a button OUTSIDE the table,
// and we only need to READ the state when the button is clicked — not
// subscribe to every change. A plain module variable is the minimum.
//
// The table component calls setCurrentTableSnapshot(...) from a useEffect
// whenever its chrome state changes. The App.jsx Export handler calls
// getCurrentTableSnapshot() at click time.

let _snapshot = null;

export function setCurrentTableSnapshot(s) {
  _snapshot = s;
}

export function getCurrentTableSnapshot() {
  return _snapshot;
}

export function clearCurrentTableSnapshot() {
  _snapshot = null;
}
