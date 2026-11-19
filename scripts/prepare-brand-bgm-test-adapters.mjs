import fs from 'node:fs/promises';
import path from 'node:path';
const base=path.resolve('.project-governance/evidence/brand-bgm-unification-20261113/deployment/candidate');
await fs.copyFile('D:/CUT-Releases/20261030-production-first-r11/config/classic-task-isolation.json',path.join(base,'config/classic-task-isolation.json'));
for(const f of ['direct-template-scope.test.mjs','direct-template-executor.integration.test.mjs'])await fs.copyFile(path.join('.direct-template-candidate/tests',f),path.join(base,'tests',f));
// Reuse the existing real-render fixture for GC, TT and NW; only copy activation assertions differ for NW.
let s=await fs.readFile('tests/classic-brand-normal.integration.test.mjs','utf8');
s=s.replace("[['guidingcross','GC']]","[['guidingcross','GC'],['tokyotiger','TT'],['nerdywave','NW']]");
s=s.replace('assert.equal(options.batch.brandCopyEnabled, true);',"if(brand!=='NW')assert.equal(options.batch.brandCopyEnabled, true);");
s=s.replace('assert.equal(options.batch.classicBrandActivation.scope,"normal_gc_tt");',"if(brand!=='NW')assert.equal(options.batch.classicBrandActivation.scope,'normal_gc_tt');");
s=s.replace('assert.equal(f.brandCopy.brand,brand);',"if(brand!=='NW')assert.equal(f.brandCopy.brand,brand);");
await fs.writeFile(path.join(base,'tests/brand-original-render.integration.test.mjs'),s);
let expanded=s.replace("[['guidingcross','GC'],['tokyotiger','TT'],['nerdywave','NW']]", "[['ironpandafit','IP'],['geeksoutfit','GK'],['teachersgram','TSG'],['purplehecate','PPH']]")
 .replaceAll("if(brand!=='NW')", "if(['GC','TT'].includes(brand))")
 .replace('assert.equal(options.batch.brandCopyContext.brandId, brand);', 'assert.equal(options.batch.brandBgmContext.brandId, brand);');
await fs.writeFile(path.join(base,'tests/brand-expanded-render.integration.test.mjs'),expanded);
