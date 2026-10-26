// @vitest-environment node
import {it,expect} from 'vitest';
// @ts-ignore build config is deliberately JavaScript
import config,{deniedImport} from '../vite.config.mjs';
it.each(['../App.tsx','./ConversationResearch','./MeetingCalendar','./ResearchPlanner','./V11.pending.ts','./integration-registry','./oidc','./security-key','./DRM','../server/main.ts'])('denies excluded import %s',id=>{expect(deniedImport.test(id)).toBe(true);expect(()=>config.plugins[0].resolveId(id)).toThrow('Excluded import');});
it('allows the explicit bounded entry and ordinary leaves',()=>{expect(config.plugins[0].resolveId('/visual-harness/main.tsx')).toBeNull();expect(config.plugins[0].resolveId('./WorkspaceManager')).toBeUndefined();});
it('denies any local dependency absent from the explicit bounded list before reading it',()=>{expect(()=>config.plugins[0].load(process.cwd()+'/candidate/src/components/SourceAssets.tsx')).toThrow('Unadmitted local build input');});

it('denies local imports escaping the bounded tree',()=>{expect(()=>config.plugins[0].load('/workspace/other/component.ts')).toThrow('Unadmitted local build input');});
