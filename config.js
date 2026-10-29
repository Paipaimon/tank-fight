/* 游戏数值统一配置。时间单位：秒；速度：像素/秒；概率：0～1。
 * 修改后重启 Node 服务并刷新页面；分离部署时两端使用同一份配置。 */
(function (root, factory) {
  const config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else { root.TankConfig = config; root.TANK_SERVER_URL = config.serverURL; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    serverURL: '', // 留空使用当前网站；分离部署示例：https://battle-api.example.com
    port: 8002,
    maxPlayers: 4, // 当前界面支持 1～4 人
    nameLength: 16,
    bulletSpeedMultiplier: 2 / 3, // 玩家与敌军弹速统一降低 1/3
    // 按房间人数（1、2、3、4人）设置；人数变化时保持当前血量比例。
    multiplayer: { playerHp:[1,1,1,1], enemyHp:[1,1,1,1], eliteHp:[1,1,1,1], bossHp:[1,1,1,1] },
    vehicles: {
      vanguard: {id:'vanguard',name:'先锋',label:'均衡主战',code:'VANGUARD / M01',hp:100,speed:175,damage:25,reload:.29,bulletSpeed:620,barrels:1,color:'#d3ee89',description:'装甲、机动与火力的可靠平衡。'},
      scout: {id:'scout',name:'游隼',label:'轻型侦察',code:'FALCON / L02',hp:75,speed:235,damage:18,reload:.22,bulletSpeed:720,barrels:1,color:'#85d5e7',description:'高速游走，快速连射，适合侧翼突袭。'},
      heavy: {id:'heavy',name:'堡垒',label:'重装坦克',code:'BASTION / H03',hp:170,speed:125,damage:45,reload:.60,bulletSpeed:540,barrels:1,color:'#e9bd7f',description:'厚重装甲与大口径重炮，稳步推进。'},
      striker: {id:'striker',name:'雷鸣',label:'散射突击',code:'THUNDER / S04',hp:90,speed:160,damage:15,reload:.47,bulletSpeed:590,barrels:3,color:'#c2a6ed',description:'自带三联散射，近距离压制成群敌军。'}
    },
    enemies: {
      normal: {name:'巡逻坦克',color:'#d97d6a',armor:1,speed:1,reload:1,damage:14,bulletSpeed:290,barrels:1,dropChance:.05,radius:16},
      elite: {name:'精英 · 猎杀者',color:'#cc98f2',armor:3,speed:1.1,reload:.8,damage:18,bulletSpeed:330,barrels:3,dropChance:.4,radius:16},
      boss: {name:'BOSS · 铁幕领主',color:'#f1bf65',armor:10,speed:.75,reload:1.4,damage:22,bulletSpeed:270,barrels:5,dropChance:1,radius:18}
    },
    supplies: {initialCount:1,firstDelay:10,interval:10,ambientLimit:6,limit:12,duration:5,repair:40,collectRadius:30,spacing:40,speedMultiplier:260/175,rapidMultiplier:.35},
    waves: {initial:1,baseEnemies:4,enemiesPerWave:.8,enemiesPerAlly:2,maxEnemies:16,eliteEvery:5,bossEvery:10,clearDelay:3,retryDelay:3,spawnProtection:2,waveProtection:3,difficulty:1,minDifficulty:.5,maxDifficulty:2},
    ai: {hp:50,hpEvery:3,hpStep:10,maxHp:110,speed:72,speedPerWave:2,maxSpeed:110,reload:1.7,reloadPerWave:.045,minReload:.7,initialCooldown:1,cooldownJitter:2,sightInterval:.1,stopDistance:230,fireDistance:650,repathInterval:.6,repathJitter:.3,waypointRadius:6,sightStep:18},
    weapons: {life:2.4,radius:3,collisionStep:5,muzzleDistance:22,enemySpread:.18,enemyInaccuracy:.08,spread:[-.19,0,.19],triple:[-.14,0,.14],enhanced:[-.28,-.14,0,.14,.28]},
    physics: {tankRadius:16,separation:.9,hz:60,maxDelta:.25,maxPredictionDelta:.2},
    map: {width:1280,height:800,tile:40,clusters:40,clusterWidth:3,clusterHeight:3,brickHp:60,steelHp:999,spawnX:[220,500,820,1100],spawnY:700,spawnAttempts:120,safeTop:3,safeBottom:16,corridorRows:[9,10],corridorColumns:[5,6,15,16,25,26],clusterMinX:2,clusterMinY:4,clusterRangeX:27,clusterRangeY:11,clusterEndX:30,clusterEndY:16,enemyFallbackX:620,enemyFallbackY:100},
    network: {bodyLimit:2048,serverRequestTimeoutMs:10000,simulationHz:30,broadcastHz:20,inputHz:30,keepaliveMs:100,inputTimeoutMs:350,disconnectGraceMs:15000,roomLifetimeMs:60000,maxRooms:64,maxInFlight:2,requestTimeoutMs:1500,connectTimeoutMs:8000,reconnectTimeoutMs:15000,sseRetryMs:1000,heartbeatMs:10000,slowClientMs:500,maxCatchupSteps:4,maxCatchupSeconds:.15,interpolationMs:75,extrapolationMs:80,staleMs:250,predictionMs:150,snapDistance:80,correctionRate:14,historyMs:1000,maxFrames:8,precision:1000},
    touch: {deadZone:.12,stickTravel:.34,breakpoint:850},
    render: {floorPatches:20,floorGrain:400,maxEffects:80,eventLimit:40,hudInterval:.1,maxFrameDelta:.05}
  };
});
