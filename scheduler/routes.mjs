// In-process engine contract; backend/inventory-scheduler.mjs mounts a strict scoped HTTP adapter.
import {capabilities} from './runner.mjs';
const invalid=()=>{throw Object.assign(new Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'})};
const fields=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!keys.includes(k)))invalid()};
export function schedulerRoutes(engine){return Object.freeze({
 'GET /local-scheduler/capabilities':input=>{fields(input,[]);return capabilities},
 'GET /local-scheduler/schedules':input=>{fields(input,[]);return engine.list()},
 'POST /local-scheduler/schedules':input=>engine.create(input),
 'POST /local-scheduler/state':input=>{fields(input,['id','state']);return engine.state(input.id,input.state)},
 'GET /local-scheduler/runs':input=>{fields(input,[]);return engine.runs().map(({token,...run})=>run)},
 'GET /local-scheduler/result':input=>{fields(input,['id']);return engine.result(input.id)},
 // Dispatch, claim, completion and timer controls are NOT client routes.
})}
