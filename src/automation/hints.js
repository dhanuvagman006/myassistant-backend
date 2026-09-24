/**
 * APP HINTS — a few lines of local knowledge per app, nothing more.
 *
 * The engine is app-agnostic: it reads whatever screen is in front of it
 * and decides from that. These hints only save steps ("search is faster
 * than scrolling the menu") and name where each app's payment step is, so
 * the planner stops at the right place. An app with no entry here works
 * the same way, just with a little more looking around — adding support
 * for a new app is at most a few sentences in this file, never code.
 */

const HINTS = {
  "in.swiggy.android": [
    "Search from the Search tab or the search bar at the top; type the dish and submit.",
    "Results can be narrowed with filter chips such as 'Ratings 4.0+' or 'Pure Veg'.",
    "Restaurant cards show the rating (e.g. 4.3) and delivery time; open one to see its menu.",
    "Inside a restaurant, the menu has its own search; tap ADD on the item, pick the default options if a sheet opens, then 'View Cart'.",
    "The cart's 'Proceed to Pay' / 'Place Order' button is the payment step: stop at the cart.",
  ],
  "com.application.zomato": [
    "Use the search bar at the top for the dish or restaurant.",
    "Filter chips such as 'Rating 4.0+' and 'Pure Veg' narrow the list.",
    "Tap ADD on the item, then 'View cart'. The cart's 'Place Order' / 'Pay' button is the payment step: stop at the cart.",
  ],
  "com.grofers.customerapp": [
    "Search for each item, tap ADD on the best match, then open the cart. Stop at the cart.",
  ],
  "com.zeptoconsumerapp": [
    "Search for each item, tap ADD on the best match, then open the cart. Stop at the cart.",
  ],
  "in.amazon.mShop.android.shopping": [
    "Search from the top bar; open a product, 'Add to Cart'. 'Buy Now' and 'Proceed to Buy' lead to payment: stop before them.",
  ],
  "com.flipkart.android": [
    "Search from the top bar; open a product, 'Add to cart'. 'Buy now' and 'Place order' are the payment step: stop before them.",
  ],
  "com.ubercab": [
    "Type the destination in 'Where to?', pick the matching suggestion, then look at the ride options. Choosing and confirming a ride books and charges it: stop at the ride options.",
  ],
  "com.olacabs.customer": [
    "Enter the drop location, pick the suggestion, then look at the ride options. Confirming books a paid ride: stop at the ride options.",
  ],
  "com.bt.bms": [
    "Search the movie, pick the showtime closest to what was asked, then seats. Paying for tickets is the owner's step.",
  ],
};

// Web forms, in any browser.
const WEB = [
  "This is a web page in a browser. Form fields show their label or placeholder as the hint.",
  "Fill each field from what you know about the owner; tap a dropdown to open it, then tap the option.",
  "Scroll down to find fields and the submit button below the fold.",
  "After submitting, check the page shows a confirmation before reporting done.",
];

function hintsFor(pkg, { web = false } = {}) {
  const own = HINTS[String(pkg || "")] || [];
  return web ? [...WEB, ...own] : own;
}

module.exports = { hintsFor, HINTS };
