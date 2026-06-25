# Diecast Inventory MVP Scope

## Goal
Build an internal inventory and simple marketplace MVP for a centralized diecast car resale business.

The first version should help us receive bulk inventory, identify each physical item, store it in a known location, list it for sale, and fulfill multi-item buyer orders.

## Do Build in MVP
- Admin dashboard
- Add/edit catalog models
- Add/edit physical item instances
- Upload item photos
- Assign storage locations
- Track item condition
- Create listings
- Buyer-facing browse/search page
- Cart
- Checkout placeholder
- Order management
- Picking list by storage location

## Do Not Build Yet
- AI camera detection
- Automated wear/tear detection
- Full encyclopedia
- Public seller portal
- Bidding exchange
- Vending machine integration
- Mobile app

## Core Data Concepts
- Catalog Model: general product identity, such as casting/year/series/color
- Item Instance: one physical car in storage
- Storage Location: where the item is stored
- Listing: public sale record
- Order: buyer purchase
- Order Item: item included in an order