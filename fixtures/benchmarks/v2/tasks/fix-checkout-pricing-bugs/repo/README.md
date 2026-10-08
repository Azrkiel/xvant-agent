# shopcart

A small checkout library. Money is held as integer cents everywhere.

- `src/pricing/` money conversion, discounts and tax
- `src/inventory/` stock reservation
- `src/cart/` the shopping cart
- `src/shipping/` shipping cost by parcel weight
- `src/checkout/` turns a cart into an order and prints a receipt

Run a test with `node test/money.test.mjs`.

Known problems are listed in `BUGS.md`.
