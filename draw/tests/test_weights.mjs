import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DRAW_DEFAULTS,validateDrawConfig,pickDrawGift} from '../model.js';

test('all 140 tickets follow requested portion weights; tissue stays two packs',()=>{
  const config=validateDrawConfig(DRAW_DEFAULTS), counts={};
  for(let ticket=0;ticket<140;ticket++) {
    const gift=pickDrawGift(config.gifts,total=>{assert.equal(total,140);return ticket;});
    counts[gift.id]=(counts[gift.id]||0)+1;
  }
  assert.deepEqual(counts,{book:30,tissue:24,bag:16,stand:20,cup:20,tote:30});
  assert.equal(config.gifts.find(g=>g.id==='tissue').quantity,2);
});
test('disabled prizes are excluded and weights renormalize',()=>{
  const config=structuredClone(DRAW_DEFAULTS);
  config.gifts.forEach(g=>g.enabled=['book','bag'].includes(g.id));
  const counts={};
  for(let ticket=0;ticket<46;ticket++) {
    const gift=pickDrawGift(config.gifts,total=>{assert.equal(total,46);return ticket;});
    counts[gift.id]=(counts[gift.id]||0)+1;
  }
  assert.deepEqual(counts,{book:30,bag:16});
  assert.equal(pickDrawGift([],()=>assert.fail('empty pool must not draw')),null);
});
test('legacy configuration gains weights without overwriting edits; saved weights persist',()=>{
  const legacy=structuredClone(DRAW_DEFAULTS);
  legacy.gifts.forEach(g=>delete g.weight);
  legacy.gifts[0].name='管理员修改';legacy.gifts[0].enabled=false;
  legacy.gifts[1].quantity=3;
  const migrated=validateDrawConfig(legacy);
  assert.deepEqual(migrated.gifts.map(g=>g.weight),[30,24,16,20,20,30]);
  assert.equal(migrated.gifts[0].name,'管理员修改');assert.equal(migrated.gifts[0].enabled,false);
  assert.equal(migrated.gifts[1].quantity,3);
  migrated.gifts[0].weight=45;
  assert.equal(validateDrawConfig(migrated).gifts[0].weight,45);
  for(const invalid of [0,-1,1.5,10000,null,'30']) {
    migrated.gifts[0].weight=invalid;assert.throws(()=>validateDrawConfig(migrated));
  }
});
