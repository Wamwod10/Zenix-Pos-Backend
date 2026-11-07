// Grounded business-growth guidance from the current authorized report.
// No model-generated figures, inferred sales trend, autonomous write, or
// assumption that absent expenses / zero payable balances imply success.
const decimal=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value);
const positive=value=>decimal(value)&&!value.startsWith('-')&&!/^0(?:\.0+)?$/.test(value);
const zero=value=>decimal(value)&&/^0(?:\.0+)?$/.test(value);
const fmt=value=>{const [whole,fraction='']=value.split('.');const digits=whole.replace(/\B(?=(\d{3})+(?!\d))/g,' ');const f=fraction.replace(/0+$/,'');return digits+(f?'.'+f:'')};
const safeName=value=>String(value||'').replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,'').trim().slice(0,90);
export function businessGrowthAdvice(report){
 const facts=Array.isArray(report?.facts)?report.facts:[];
 const get=id=>facts.find(f=>f?.id===id&&decimal(f.value));
 const count=get('today_sales_sales_count'),net=get('today_sales_today_net');
 const low=get('inventory_warehouse_low_stock_count'),customer=get('customer_debt_customer_debt');
 const supplier=get('supplier_debt_supplier_debt'),expenses=get('expenses_expenses');
 const profitable=facts.filter(f=>/^profit_profit_\d+$/.test(f?.id||'')&&positive(f.value)&&safeName(f.productName||String(f.label||'').split(':')[0])).slice(0,2);
 const scope=report?.sellerScoped?'sizga ruxsat etilgan savdolar':report?.storeId?'tanlangan filial':'ruxsat etilgan filiallar';
 const steps=[];
 const trendCurrent=get('trend_period_current_net'),trendPrevious=get('trend_period_comparison_net');
 const trendDelta=get('trend_period_delta_net');
 // The difference is computed by the existing read-only sales comparison tool.
 // Its exact decimal strings and explicit dates are preserved, never converted
 // to floating-point and never misrepresented as gross profit or causation.
 if(trendCurrent&&trendPrevious&&trendDelta&&
    trendCurrent.from&&trendCurrent.to&&trendPrevious.from&&trendPrevious.to){
  const decrease=trendDelta.value.startsWith('-')&&!zero(trendDelta.value);
  const direction=decrease?'kam':positive(trendDelta.value)?'ko‘p':'teng';
  const difference=decrease?trendDelta.value.slice(1):trendDelta.value;
  const next=decrease?
   'Qaytarishlar va mahsulotlar kesimidagi tushumni alohida tekshiring; sababini bu farqning o‘zi isbotlamaydi.':
   'Qaysi mahsulotlar va qaytarishlar ta’sir qilganini alohida tekshiring; bu sof foyda oshganini isbotlamaydi.';
  steps.push('Teng davrlarni solishtiring: '+trendCurrent.from+' — '+trendCurrent.to+
   ' sof savdo '+fmt(trendCurrent.value)+' so‘m; '+trendPrevious.from+' — '+trendPrevious.to+
   ' sof savdo '+fmt(trendPrevious.value)+' so‘m. Joriy davr farqi '+
   (direction==='teng'?'0 so‘m':fmt(difference)+' so‘mga '+direction)+'. '+next);
 }
 if(count&&zero(count.value)){
  steps.push(trendCurrent&&trendPrevious&&trendDelta?
   'Bugun '+scope+' bo‘yicha savdo qayd etilmagan. Bitta kunning natijasi sababni isbotlamaydi. Qaysi mahsulotlar oldingi kunlarda sotilganini tekshirib, kichik aksiya natijasini o‘lchang.':
   'Savdoni oldingi teng davrlar bilan solishtiring. Bugun '+scope+' bo‘yicha savdo qayd etilmagan, ammo bitta kun sabab yoki trendni isbotlamaydi. Oxirgi 7–30 kundagi kunlar va sotilgan mahsulotlarni tekshirib, keyin kichik aksiya sinab ko‘ring.');
 }else if(count&&positive(count.value)){
  steps.push('Savdo natijasini mahsulotlar kesimida tekshiring. Bugun '+scope+' bo‘yicha '+fmt(count.value)+' ta savdo qayd etilgan'+(net?' (sof tushum '+fmt(net.value)+' so‘m)':'')+'. Qaysi mahsulotlar qayta xarid qilinayotganini va teng davrlardagi sotuvni solishtirib, bitta aniq taklifni sinang.');
 }else{
  steps.push('O‘sish nuqtasini aniqlang: oxirgi 7–30 kunlik savdo, savdo soni va mahsulotlar kesimini teng davrlar bilan solishtiring. Joriy hisobotdan savdo o‘sish sur’atini tasdiqlab bo‘lmaydi.');
 }
 if(profitable.length){
  const names=profitable.map(f=>safeName(f.productName||String(f.label).split(':')[0])).join(' va ');
  steps.push(names+' bo‘yicha sotilish tezligi va foyda marjasini tekshiring. Bu mahsulotlarning tarixiy tannarx asosidagi foydasi qayd etilgan, lekin ularning yuqori tushumi kelajakdagi talabni kafolatlamaydi. Qoldiq va qaytarishlarni ko‘rib, foydali assortimentni kichik sinov bilan kengaytiring.');
 }
 if(low&&positive(low.value)){
  steps.push('Qoldiq bo‘yicha '+fmt(low.value)+' ta minimum yoki undan past mahsulotni tekshiring. Ularning haqiqiy sotilish tezligi va yetkazish muddatini ko‘rib, kerak bo‘lsa kirim rejasini tuzing; tasdiqsiz kirim qilmang.');
 }
 if(customer&&positive(customer.value)){
  steps.push('Mijozlardan olinadigan '+fmt(customer.value)+' so‘mlik qarzning muddati o‘tgan qismini tekshiring. Muddati kelgan to‘lovlar uchun undirish rejasini tuzing; barchasi kechikkan deb taxmin qilmang.');
 }
 if(expenses&&zero(expenses.value)){
  steps.push('Xarajat yozuvlarini to‘liqligini tekshiring: ko‘rsatilgan davrda 0 so‘m yozuv qayd etilgan. Bu haqiqiy xarajatlar nol yoki biznesning sof foydasi yuqori ekanini anglatmaydi.');
 }
 if(supplier&&positive(supplier.value)){
  steps.push('Ta’minotchilarga '+fmt(supplier.value)+' so‘mlik qarz bo‘yicha to‘lov muddatlarini tekshiring; faqat muddati yaqin yoki kechikkanlarini rejalashtiring.');
 }
 if(steps.length<3)steps.push('Mahsulot tannarxi, qaytarishlar va operatsion xarajatlarni solishtiring. Mahsulot foydasini biznesning yakuniy sof foydasi deb qabul qilmang.');
 if(steps.length<3)steps.push('Bitta o‘lchanadigan savdo yoki assortiment tajribasini o‘tkazing va natijani oldingi teng davr bilan taqqoslang.');
 const answer='Biznesingizni rivojlantirish uchun hozir quyidagi ishlarni tavsiya qilaman:\n\n'+steps.slice(0,3).map((s,i)=>String(i+1)+'. '+s).join('\n\n')+
  '\n\n'+(trendCurrent&&trendPrevious&&trendDelta?
   'Keyingi qadam: mahsulotlar kesimida sof savdo va qaytarishlarni tekshiring. Bitta o‘zgarishni sinab, keyingi teng davrda natijani o‘lchang.':
   'Keyingi qadam: savdoni teng davrlar bo‘yicha tekshiring. Shundan keyin qaysi o‘zgarish haqiqatan foyda berayotganini o‘lchash mumkin.');
 return {answerSource:facts.some(f=>decimal(f?.value))?'verified_fallback':'clarification_fallback',answer};
}
