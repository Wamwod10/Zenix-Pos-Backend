// Observe actual client query duration separately from pool acquisition wait.
export function instrumentPool(pool,metrics,clock=()=>performance.now()){
 if(!metrics.enabled)return pool;
 const connect=pool.connect.bind(pool),instrumented=new WeakSet();
 const track=client=>{
  if(!client||instrumented.has(client))return client;
  instrumented.add(client);const query=client.query;
  client.query=function(...args){
   let recorded=false;
   const start=clock(),observe=error=>{if(!recorded){recorded=true;metrics.observe('db.query',clock()-start,{failed:Boolean(error)})}};
   const callback=args.at(-1);
   if(typeof callback==='function')args[args.length-1]=function(error,...rest){observe(error);return callback.call(this,error,...rest)};
   try{
    const result=query.apply(this,args);
    if(typeof callback!=='function'&&typeof result?.then==='function')return result.then(value=>{observe();return value},error=>{observe(error);throw error});
    return result;
   }catch(error){observe(error);throw error}
  };
  return client;
 };
 pool.connect=function(callback){
  const start=clock(),observe=error=>metrics.observe('db.acquire',clock()-start,{failed:Boolean(error)});
  if(typeof callback==='function')return connect((error,client,release)=>{observe(error);callback(error,track(client),release)});
  return connect().then(client=>{observe();return track(client)},error=>{observe(error);throw error});
 };
 return pool;
}
