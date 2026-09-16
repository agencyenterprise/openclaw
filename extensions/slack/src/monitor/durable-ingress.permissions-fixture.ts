import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createChannelIngressQueue } from '../../../../src/channels/message/ingress-queue.js';
function readStateDir(): string {
 const value=process.argv[2];
 if (!value || !path.isAbsolute(value)) throw new Error("Fixture requires absolute state directory");
 return value;
}
const stateDir=readStateDir();
const queue=createChannelIngressQueue({channelId:'slack',accountId:'permissions-fixture',stateDir});
await queue.enqueue('synthetic-permission-check',{text:'Synthetic private queue fixture'},{laneKey:'fixture-thread'});
const files:Array<{name:string;mode:string;private:boolean}>=[];
function walk(directory:string,depth:number){
 if(depth>5) throw new Error('Unexpected fixture depth');
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const full=path.join(directory,entry.name);
  if(entry.isSymbolicLink()) throw new Error('Unexpected fixture symlink');
  if(entry.isDirectory()) walk(full,depth+1);
  else if(/(?:sqlite|db)(?:-(?:wal|shm))?$/.test(entry.name)){
   const st=statSync(full);files.push({name:path.relative(stateDir,full),mode:(st.mode&0o777).toString(8),private:(st.mode&0o077)===0});
  }
 }
}
walk(stateDir,0);
if(!files.length || files.some(f=>!f.private) || (statSync(stateDir).mode&0o077)!==0) throw new Error('Private queue permission assertion failed');
process.stdout.write(JSON.stringify({files,stateDirectoryPrivate:true}));
