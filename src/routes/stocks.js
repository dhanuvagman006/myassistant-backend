const router = require("express").Router();

router.get("/", (req, res) => {
  res.json({
    invest: [
      { symbol: "TCS", name: "Tata Consultancy Services", price: 3840.50, change: "+1.2%", reason: "Strong Q2 cloud revenues and AI investments." },
      { symbol: "RELIANCE", name: "Reliance Industries", price: 2980.10, change: "+0.8%", reason: "Jio IPO announcements and retail expansion." },
      { symbol: "HDFCBANK", name: "HDFC Bank", price: 1650.00, change: "+2.1%", reason: "Merger synergies starting to reflect in NIMs." }
    ],
    sell: [
      { symbol: "PAYTM", name: "One97 Communications", price: 420.30, change: "-4.5%", reason: "Regulatory hurdles and margin pressures." },
      { symbol: "IDEA", name: "Vodafone Idea", price: 13.50, change: "-1.1%", reason: "Continued subscriber loss and debt overhang." }
    ],
    news: [
      { headline: "Nifty 50 hits new all-time high amidst foreign inflows.", source: "Mint", time: "2h ago" },
      { headline: "RBI keeps repo rate unchanged at 6.5%.", source: "Moneycontrol", time: "4h ago" },
      { headline: "IT sector expected to see moderate growth this fiscal.", source: "ET Markets", time: "5h ago" }
    ]
  });
});

module.exports = router;
