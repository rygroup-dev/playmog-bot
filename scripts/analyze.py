import json,sys,collections,glob
f=sys.argv[1] if len(sys.argv)>1 else max(glob.glob('data/runs/*.jsonl'),key=lambda p:__import__('os').path.getmtime(p))
L=[x for x in (json.loads(l) for l in open(f) if l.strip()) if 'events' in x and 'turn' in x]
spend=collections.Counter(); gain=collections.Counter(); reason_cost=collections.Counter(); dmg_src=collections.Counter()
for r in L:
    rs=r['reason'].split(' ')[0]
    for e in r['events']:
        t=e['type']
        if t in('player_moved','turn_passed'): c=e.get('energyCost',1); spend['move' if t=='player_moved' else 'pass']+=c; reason_cost[rs]+=c
        if t=='player_damaged':
            a=e.get('amount') or e.get('damage') or 0; spend['damage']+=a; dmg_src[str(e.get('source') or e.get('enemyId','?'))[:28]]+=a
        if t=='pickup_collected' and 'orb' in e.get('pickupType',''): gain['orb']+=e.get('value',0)
        if t=='player_healed': gain['heal:'+str(e.get('source'))]+=e.get('amount',0)
        if t=='level_up': gain['levelup']+=e.get('energyRegen',0)
print('file',f,'turns',len(L))
print('SPEND',dict(spend)); print('GAIN',dict(gain))
print('move energy by reason',reason_cost.most_common(8))
print('damage by source',dmg_src.most_common(8))
fl=collections.defaultdict(lambda:[None,None,0,0])
for r in L:
    x=fl[r['floor']]; x[0]=x[0] or r['energy']; x[1]=r['energy']; x[2]+=1
    x[3]+=sum(e.get('value',0) for e in r['events'] if e['type']=='pickup_collected' and e.get('pickupType')=='treasure')
for k,v in sorted(fl.items()): print(f'floor {k}: energy {v[0]}->{v[1]} turns {v[2]} treasure +{v[3]}')
