import { createCronExitWatchers } from "../../src/gateway/cron-exit-watchers.js";
import { loadCronStore } from "../../src/cron/store.js";
const storePath=process.argv[2];if(!storePath)throw Error("FIXTURE_PATH");
const jobs=(await loadCronStore(storePath)).jobs;
const watchers=createCronExitWatchers({getProcessSupervisor:()=>{throw Error("NO_SPAWN_BEFORE_ADMISSION");},resolveDispatchOrigin:job=>{if(!job.sessionKey)throw Error("SOURCE");return job.sessionKey;},persistCompletion:async()=>{throw Error("NO_COMPLETION");},fireOnExit:()=>{throw Error("NO_FIRE");},logger:{info:()=>{},warn:(record)=>{if((record as {err?:string}).err!=="NativeDispatchBusyError: NATIVE_BUSY")process.exit(18);process.stdout.write("ORIGINAL_BUSY_BEFORE_SPAWN\n");process.exit(17);}}});
watchers.reconcile(jobs);
setTimeout(()=>process.exit(19),1000);
