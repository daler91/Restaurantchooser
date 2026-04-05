const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Serve API key from environment variable (set in Railway dashboard)
app.get("/api/config", (req, res) => {
  res.json({ apiKey: process.env.GOOGLE_PLACES_API_KEY || "" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Restaurant Picker running on port ${PORT}`);
});
