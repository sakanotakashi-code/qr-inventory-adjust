import express from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const { SHOPIFY_STORE, SHOPIFY_TOKEN, LOCATION_ID, LINK_SECRET, PORT = 3000 } = process.env;
if (!SHOPIFY_STORE || !SHOPIFY_TOKEN || !LOCATION_ID || !LINK_SECRET) {
  console.error("Missing required env vars. Check .env");
  process.exit(1);
}

const app = express();

// 署名
function sign({ vi, d, exp }) {
  const payload = `${vi}.${d}.${exp}`;
  return crypto.createHmac("sha256", LINK_SECRET).update(payload).digest("hex");
}
// 検証
function verify({ vi, d, exp, sig }) {
  if (!vi || !d || !exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Number(exp) < now) return false;
  const expected = sign({ vi, d, exp });
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

// Shopify API クライアント
const api = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2024-10`,
  headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
  timeout: 10000,
});

// ping ルート（疎通確認用）
app.get("/ping", async (_req, res) => {
  try {
    const { data } = await api.get("/shop.json");
    res.json({ ok: true, shop: data?.shop?.name || "ok" });
  } catch (e) {
    res.status(500).json({ ok: false, err: e?.response?.data || e.message });
  }
});

// /gen : 署名付きURLを発行
app.get("/gen", (req, res) => {
  const { vi, d, ttl = "31536000" } = req.query;
  if (!vi || !["1", "-1"].includes(String(d))) {
    return res.status(400).send("Usage: /gen?vi=<inventory_item_id>&d=1|-1&ttl=seconds");
  }
  const exp = Math.floor(Date.now() / 1000) + Number(ttl);
  const sig = sign({ vi, d, exp });
  const link = `${req.protocol}://${req.get("host")}/adjust?vi=${vi}&d=${d}&exp=${exp}&sig=${sig}`;
  res.send(`<p><a href="${link}">${link}</a></p>`);
});

// /adjust : 在庫を±1
app.get("/adjust", async (req, res) => {
  const { vi, d, exp, sig } = req.query;
  try {
    if (!verify({ vi, d, exp, sig })) return res.status(403).send("Invalid or expired link");
    const delta = Number(d);
    if (![1, -1].includes(delta)) return res.status(400).send("Delta must be 1 or -1.");

    // 在庫調整
    const { data } = await api.post(`/inventory_levels/adjust.json`, {
      location_id: Number(LOCATION_ID),
      inventory_item_id: Number(vi),
      available_adjustment: delta,
    });
    res.send(`<h2>在庫を ${delta > 0 ? "+1" : "-1"} しました</h2><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`);
  } catch (e) {
    res.status(500).send(`<h3>Inventory update failed</h3><pre>${escapeHtml(JSON.stringify(e?.response?.data || e.message, null, 2))}</pre>`);
  }
});

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

app.listen(Number(PORT), () => console.log(`Listening on http://localhost:${PORT}`));
