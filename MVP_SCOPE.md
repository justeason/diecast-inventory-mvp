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

## Future Product Direction

These are future milestones and should not be implemented now. The immediate next milestone remains photo-assisted inventory intake with human review.

### 1. User Collection Tracker
- Users can create accounts and record their own Hot Wheels/diecast collection.
- User-owned collection items are separate from business-owned inventory items.
- User inventory is private by default.
- Users may opt in to show anonymous supply or indicate willingness to sell.

### 2. Bid/Ask Marketplace
- Buyers can place bids on catalog models.
- Sellers can place asks.
- Buy Now is based on the lowest active ask.
- Sell Now is based on the highest active bid.
- Start with manual matching/notifications before automatic matching.

### 3. Market Intelligence
- Model pages can show highest bid, lowest ask, last sale, number available, number wanted, number in user collections, top-selling models, and estimated portfolio value.