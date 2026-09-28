import test from "node:test";
import assert from "node:assert/strict";
import { formatNotification } from "../src/services/telegram.js";

const cases = [
  ["sale.completed", "Yangi savdo", { storeName:"Asosiy filial", sellerName:"Shamshod", saleNumber:"S-100", itemCount:2, total:15000 }],
  ["sale.returned", "Qaytarish", { storeName:"Asosiy filial", saleNumber:"S-100", userName:"Shamshod", quantity:1, amount:5000, reason:"Almashtirish" }],
  ["shift.opened", "Smena ochildi", { storeName:"Asosiy filial", cashierName:"Shamshod", openingCash:100000 }],
  ["shift.closed", "Smena yopildi", { storeName:"Asosiy filial", cashierName:"Shamshod", expectedCash:250000, actualCash:250000, difference:0 }],
  ["inventory.received", "Omborga kirim", { storeName:"Asosiy filial", lineCount:3, total:120000, supplierName:"Hamkor" }],
  ["inventory.transfer_dispatched", "Transfer jo‘natildi", { fromStoreName:"Asosiy filial", toStoreName:"Ikkinchi filial", lineCount:2, totalQuantity:8 }],
  ["inventory.transfer_received", "Transfer qabul qilindi", { fromStoreName:"Asosiy filial", toStoreName:"Ikkinchi filial", lineCount:2, receivedQuantity:8, hasDifference:false }],
  ["inventory.transfer_cancelled", "Transfer bekor qilindi", { fromStoreName:"Asosiy filial", toStoreName:"Ikkinchi filial", previousStatus:"Jo‘natilgan" }],
  ["inventory.low", "Mahsulot kamayib qoldi", { storeName:"Asosiy filial", productName:"Cola", quantity:2, minStock:5 }],
  ["inventory.out", "Mahsulot tugadi", { storeName:"Asosiy filial", productName:"Cola", quantity:0 }],
  ["daily.report", "Kunlik hisobot", { storeName:"Asosiy filial", businessDate:"2026-09-28", saleCount:5, total:300000, cash:100000, card:150000, transfer:50000 }],
  ["expense.created", "Yangi xarajat", { storeName:"Asosiy filial", userName:"Shamshod", category:"Transport", title:"Yetkazish", amount:30000 }],
  ["supplier.debt", "Ta’minotchi qarzi", { storeName:"Asosiy filial", supplierName:"Hamkor", invoiceNo:"N-10", debt:80000, dueDate:"2026-10-01" }],
];

test("all Telegram business notifications produce complete balanced HTML", () => {
  for (const [eventType, title, payload] of cases) {
    const message = formatNotification(eventType, payload);
    assert.match(message, new RegExp(`<b>${title}</b>`), eventType);
    assert.doesNotMatch(message, /undefined|NaN|\[object Object\]/, eventType);
    assert.equal((message.match(/<b>/g) || []).length, (message.match(/<\/b>/g) || []).length, eventType);
    assert.ok(message.length > title.length + 20, eventType);
  }
});

test("Telegram notification values are escaped before HTML delivery", () => {
  const message = formatNotification("sale.completed", {
    storeName:"A & B <filial>", sellerName:"Ali > Vali", saleNumber:'S-"1"', itemCount:1, total:15000,
  });

  assert.match(message, /A &amp; B &lt;filial&gt;/);
  assert.match(message, /Ali &gt; Vali/);
  assert.match(message, /S-&quot;1&quot;/);
  assert.doesNotMatch(message, /<filial>/);
});
