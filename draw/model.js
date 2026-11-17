const DEFAULT_WEIGHTS = {"book": 30, "tissue": 24, "bag": 16, "stand": 20, "cup": 20, "tote": 30};
export const DRAW_DEFAULTS = {activityEnabled:true, showQuantity:true, gifts:[
  {id:'book',weight:30,name:'A5 软皮计划本',note:'梦瑾 · 记录每一份灵感',icon:'book',quantity:1,unit:'本',enabled:true},
  {id:'tissue',weight:24,name:'维达联名抽纸',note:'线条小狗 · 柔软好心情',icon:'tissue',quantity:2,unit:'包',enabled:true},
  {id:'bag',weight:16,name:'山茶花抽绳垃圾袋',note:'加厚免撕 · 让家更整洁',icon:'bag',quantity:1,unit:'份',enabled:true},
  {id:'stand',weight:20,name:'金属旋转手机支架',note:'360° 旋转 · 解放双手',icon:'stand',quantity:1,unit:'个',enabled:true},
  {id:'cup',weight:20,name:'竹节吸管随行杯',note:'把温柔 · 装进日常',icon:'cup',quantity:1,unit:'个',enabled:true},
  {id:'tote',weight:30,name:'便携折叠环保袋',note:'轻装出门 · 满载美好',icon:'tote',quantity:1,unit:'个',enabled:true}
]};

export function validateDrawConfig(value) {
  if (!value || typeof value.activityEnabled !== 'boolean' || typeof value.showQuantity !== 'boolean' || !Array.isArray(value.gifts) || value.gifts.length > 12) throw Error('礼品设置格式有误');
  const ids = new Set(), icons = ['book','tissue','bag','stand','cup','tote','gift'];
  const gifts = value.gifts.map(gift => {
    if (!gift || typeof gift.id !== 'string' || !gift.id || gift.id.length > 100 || ids.has(gift.id) ||
        typeof gift.name !== 'string' || !gift.name.trim() || gift.name.length > 32 ||
        typeof gift.note !== 'string' || gift.note.length > 64 || !icons.includes(gift.icon) ||
        !Number.isInteger(gift.quantity) || gift.quantity < 1 || gift.quantity > 99 ||
        typeof gift.unit !== 'string' || !gift.unit.trim() || gift.unit.length > 6 || typeof gift.enabled !== 'boolean') throw Error('请检查礼品名称、每份数量与单位');
    // Existing D1 configurations gain weights without replacing other edits.
    const weight = gift.weight === undefined ? (Object.hasOwn(DEFAULT_WEIGHTS,gift.id) ? DEFAULT_WEIGHTS[gift.id] : 20) : gift.weight;
    if(!Number.isInteger(weight) || weight < 1 || weight > 9999) throw Error('抽取权重应为 1–9999 的整数');
    ids.add(gift.id);
    return {id:gift.id,weight,name:gift.name.trim(),note:gift.note.trim(),icon:gift.icon,quantity:gift.quantity,unit:gift.unit.trim(),enabled:gift.enabled};
  });
  return {activityEnabled:value.activityEnabled,showQuantity:value.showQuantity,gifts};
}

// randomIndex must return an unbiased integer in [0, totalWeight).
export function pickDrawGift(gifts, randomIndex) {
  const eligible = gifts.filter(gift => gift.enabled);
  const total = eligible.reduce((sum,gift) => sum + gift.weight,0);
  if(!total) return null;
  let ticket = randomIndex(total);
  for(const gift of eligible) {
    if(ticket < gift.weight) return gift;
    ticket -= gift.weight;
  }
  throw Error('Invalid draw ticket');
}
