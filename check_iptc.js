const axios = require('axios');
const http = require('http');
const base = 'http://semaphore.ternquist.com:5080';

async function getToken() {
  const params = new URLSearchParams({ j_username: 'admin', j_password: 'admin' });
  const r1 = await axios.post(base + '/j_security_check', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0, validateStatus: s => s < 400
  });
  const cookie = r1.headers['set-cookie']?.find(c => c.includes('JSESSIONID')) || '';
  const jsid = cookie.split(';')[0];
  const r2 = await axios.get(base + '/api/token?lifeTime=3600', {
    headers: { 'Cookie': jsid }, validateStatus: s => s < 500
  });
  return r2.data?.tokenId;
}

async function main() {
  const token = await getToken();
  
  // 1. Check CLS publish sets
  const r1 = await axios.get('http://semaphore.ternquist.com:5058/?op=listpublishsets', { timeout: 5000 });
  const sets = r1.data.match(/<publishset[^>]+>/g) || [];
  console.log('CLS publish sets:');
  sets.forEach(s => console.log(' ', s));
  
  // 2. Check PublishEvent in IPTC .tch graph
  const q = 'PREFIX sempub: <http://www.smartlogic.com/2017/06/semaphore-publisher#> SELECT ?e ?t ?status ?env WHERE { GRAPH <urn:x-evn-master:IPTCMediaTopics.tch> { ?e a sempub:PublishEvent ; sempub:startedAt ?t . OPTIONAL { ?e sempub:hasStatus ?status } . OPTIONAL { ?e sempub:environment ?env } } } ORDER BY DESC(?t) LIMIT 3';
  const encoded = encodeURIComponent(q);
  const raw = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'semaphore.ternquist.com', port: 5080,
      path: '/kmm/api/model:IPTCMediaTopics/sparql?query=' + encoded,
      headers: { 'x-api-key': token }
    };
    http.get(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  const valRe = /<(?:uri|literal)[^>]*>([^<]+)<\/(?:uri|literal)>/g;
  let m;
  const vals = [];
  while ((m = valRe.exec(raw)) !== null) vals.push(m[1]);
  console.log('\nIPTC PublishEvents:');
  for (let i=0; i<vals.length; i+=4) {
    console.log('  Event:', vals[i] ? vals[i].split(':').pop().substring(0,30) : '?');
    console.log('  Time:', vals[i+1]);
    console.log('  Status:', vals[i+2] ? vals[i+2].split('#').pop() : '?');
    console.log('  Env:', vals[i+3]);
  }
  if (!vals.length) console.log('  (none)');
  
  // 3. Quick classify test
  const clsBody = 'body=technology+artificial+intelligence+machine+learning+news+media+sports+economy&threshold=0&language=en1';
  const r3 = await axios.post('http://semaphore.ternquist.com:5058/', clsBody, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000
  });
  const metaRe = /name="([^"]+)"[^>]+value="([^"]+)"[^>]+score="([^"]+)"/g;
  let m2;
  const hits = [];
  while ((m2 = metaRe.exec(r3.data)) !== null) hits.push({ name: m2[1], value: m2[2], score: m2[3] });
  console.log('\nClassification hits:', hits.length);
  hits.slice(0, 8).forEach(h => console.log(' ', h.name, '|', h.value, '| score:', h.score));
}
main().catch(console.error);
