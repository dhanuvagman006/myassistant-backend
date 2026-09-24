/**
 * TIPS — a few lines of general know-how per KIND of task, never per
 * company. The engine reads whatever screen is in front of it and works
 * in any app; these only save steps and name where the payment step
 * usually sits so the planner stops at the right place. An app or a task
 * with no tips here works the same way, with a little more looking around.
 */

const BY_CATEGORY = {
  food: [
    "Food delivery apps: search the dish, narrow with filter chips (rating 4.0+, pure veg), open a restaurant, tap ADD on the item (pick the default options if a sheet opens), then open the cart.",
    "The cart's pay / place-order button is the payment step: stop at the cart.",
  ],
  grocery: [
    "Quick-commerce apps: search each item, tap ADD on the best match, then open the cart. Stop at the cart.",
  ],
  shopping: [
    "Shopping apps: search from the top bar, open the product, 'Add to cart'. 'Buy now', 'Proceed to buy' and 'Place order' are the payment step: stop before them.",
  ],
  ride: [
    "Ride apps: type the destination, pick the matching suggestion, then look at the ride options. Choosing and confirming a ride books and charges it: stop at the options.",
  ],
  movies: [
    "Ticket apps: search the movie or event, pick the showtime closest to what was asked, then seats. Paying for tickets is the owner's step.",
  ],
  travel: [
    "Travel apps: enter from, to and date, search, and sort or filter as asked. Booking and paying are the owner's step.",
  ],
};

// Every task: how to get around the phone itself.
const PHONE = [
  "open_app opens any installed app by name; home and back work from anywhere.",
  "Quick settings (swipe-down panel) has Wi-Fi, Bluetooth, torch, mobile data, rotation and do-not-disturb toggles.",
  "The Settings app has a search bar at the top — search the setting's name instead of browsing.",
];

// Web forms, in any browser.
const WEB = [
  "This is a web page in a browser. Form fields show their label or placeholder as the hint.",
  "Fill each field from what you know about the owner; tap a dropdown to open it, then tap the option.",
  "Scroll down to find fields and the submit button below the fold.",
  "After submitting, check the page shows a confirmation before reporting done.",
];

function hintsFor(category, { web = false } = {}) {
  const own = BY_CATEGORY[String(category || "").toLowerCase()] || [];
  return [...(web ? WEB : []), ...own, ...PHONE];
}

module.exports = { hintsFor, BY_CATEGORY };
