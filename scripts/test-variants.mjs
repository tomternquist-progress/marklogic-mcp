/**
 * Test multiple publisher config variants to find what works.
 */
import { initLogger } from "../dist/utils/logger.js";
import { SemaphoreClient } from "../dist/client/semaphore.js";
import JSZip from "jszip";

initLogger({ level: "warn", format: "pretty" });

const config = { host: "semaphore.ternquist.com", scsPort: 5058, kmmPort: 5080, username: "admin", password: "admin", ssl: false };
const semaphore = new SemaphoreClient(config);
const MODEL = "model:IPTCMediaTopics";

const VARIANTS = {
  // Variant A: Remove LANGMATCHES filter, rely on languageCodes property
  "no-filter": `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns="http://www.springframework.org/schema/beans"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd" default-lazy-init="true">
  <bean class="com.smartlogic.workbench.publisher.Configuration">
    <property name="description" value="TEST: no-filter variant"/>
    <property name="environments"><list/></property>
  </bean>
  <bean id="PlainSkosModel" parent="SparqlEndpoint">
    <property name="getPrefLabelsSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship
        WHERE {
          BIND(skos:prefLabel AS ?prefLabelRelationship) .
          ?termUri skos:prefLabel ?prefLabel .
          BIND(?termUri AS ?prefLabelUri) .
        }
      ]]></value>
    </property>
    <property name="getAltLabelsForwardSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT DISTINCT ?termUri ?labelUri ?labelLiteral
        WHERE {
          ?termUri skos:altLabel ?labelLiteral .
          BIND(?termUri AS ?labelUri) .
        }
      ]]></value>
    </property>
  </bean>
  <bean class="com.smartlogic.publisher.Publisher">
    <property name="model" ref="PlainSkosModel"/>
    <property name="configurationSets">
      <list>
        <bean parent="AllConcepts">
          <property name="languageCodes"><list><value>en</value></list></property>
          <property name="outputProcessors">
            <list>
              <bean id="NamedEntityRules" parent="RulebaseWriterTemplate">
                <property name="templateFileName" value="ContextualCitation.kid"/>
              </bean>
              <ref bean="environmentCSWriter"/>
            </list>
          </property>
        </bean>
      </list>
    </property>
    <property name="modelUpdater" ref="OEUpdater"/>
  </bean>
  <import resource="file:\${resources.directory}/import/ModelInterface.xml"/>
  <import resource="file:\${resources.directory}/import/ModelDefinition.xml"/>
  <import resource="file:\${resources.directory}/import/RulebaseStructure.xml"/>
  <import resource="file:\${resources.directory}/import/SESConfiguration.xml"/>
  <import resource="file:\${resources.directory}/import/ConfigurationSets.xml"/>
</beans>`,

  // Variant B: UNESCO exact pattern (LANG() = "en", not LANGMATCHES)
  "lang-strict": `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns="http://www.springframework.org/schema/beans"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd" default-lazy-init="true">
  <bean class="com.smartlogic.workbench.publisher.Configuration">
    <property name="description" value="TEST: lang-strict variant (UNESCO pattern)"/>
    <property name="environments"><list/></property>
  </bean>
  <bean id="PlainSkosModel" parent="SparqlEndpoint">
    <property name="getPrefLabelsSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship
        WHERE {
          BIND(skos:prefLabel AS ?prefLabelRelationship) .
          ?termUri skos:prefLabel ?prefLabel .
          FILTER(LANG(?prefLabel) = "en")
          BIND(?termUri AS ?prefLabelUri) .
        }
      ]]></value>
    </property>
    <property name="getAltLabelsForwardSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT DISTINCT ?termUri ?labelUri ?labelLiteral
        WHERE {
          ?termUri skos:altLabel ?labelLiteral .
          FILTER(LANG(?labelLiteral) = "en")
          BIND(?termUri AS ?labelUri) .
        }
      ]]></value>
    </property>
  </bean>
  <bean class="com.smartlogic.publisher.Publisher">
    <property name="model" ref="PlainSkosModel"/>
    <property name="configurationSets">
      <list>
        <bean parent="AllConcepts">
          <property name="languageCodes"><list><value>en</value></list></property>
          <property name="outputProcessors">
            <list>
              <bean id="NamedEntityRules" parent="RulebaseWriterTemplate">
                <property name="templateFileName" value="ContextualCitation.kid"/>
              </bean>
              <ref bean="environmentCSWriter"/>
            </list>
          </property>
        </bean>
      </list>
    </property>
    <property name="modelUpdater" ref="OEUpdater"/>
  </bean>
  <import resource="file:\${resources.directory}/import/ModelInterface.xml"/>
  <import resource="file:\${resources.directory}/import/ModelDefinition.xml"/>
  <import resource="file:\${resources.directory}/import/RulebaseStructure.xml"/>
  <import resource="file:\${resources.directory}/import/SESConfiguration.xml"/>
  <import resource="file:\${resources.directory}/import/ConfigurationSets.xml"/>
</beans>`,

  // Variant C: Default SparqlEndpoint (SKOS-XL) — uses skosxl:prefLabel triples we added
  "default-skosxl": `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns="http://www.springframework.org/schema/beans"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd" default-lazy-init="true">
  <bean class="com.smartlogic.workbench.publisher.Configuration">
    <property name="description" value="TEST: default SKOS-XL SparqlEndpoint"/>
    <property name="environments"><list/></property>
  </bean>
  <bean class="com.smartlogic.publisher.Publisher">
    <property name="model" ref="SparqlEndpoint"/>
    <property name="configurationSets">
      <list>
        <bean parent="AllConcepts">
          <property name="languageCodes"><list><value>en</value></list></property>
          <property name="outputProcessors">
            <list>
              <bean id="NamedEntityRules" parent="RulebaseWriterTemplate">
                <property name="templateFileName" value="ContextualCitation.kid"/>
              </bean>
              <ref bean="environmentCSWriter"/>
            </list>
          </property>
        </bean>
      </list>
    </property>
    <property name="modelUpdater" ref="OEUpdater"/>
  </bean>
  <import resource="file:\${resources.directory}/import/ModelInterface.xml"/>
  <import resource="file:\${resources.directory}/import/ModelDefinition.xml"/>
  <import resource="file:\${resources.directory}/import/RulebaseStructure.xml"/>
  <import resource="file:\${resources.directory}/import/SESConfiguration.xml"/>
  <import resource="file:\${resources.directory}/import/ConfigurationSets.xml"/>
</beans>`,
};

async function testVariant(variantName, xml) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing variant: ${variantName}`);
  console.log("=".repeat(60));

  // Download current ZIP
  const zipBuf = await semaphore.kmmDownloadPublishConfigZip(MODEL);
  const zip = await JSZip.loadAsync(zipBuf);

  // Replace publisher XML
  zip.file("Semaphore-Publisher-CS-only.xml", xml);

  // Upload
  const newZip = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  await semaphore.kmmUploadPublishConfigZip(MODEL, newZip);
  console.log("Config uploaded.");

  // Publish
  const { accepted, jobId } = await semaphore.kmmPublish(MODEL, { async: true });
  console.log(`Publish accepted: ${accepted}, jobId: ${jobId}`);

  // Wait for job
  const result = await semaphore.kmmWaitForAsyncJob(jobId, 180_000, 5_000);
  console.log(`Job status: ${result.status}`);

  // Wait a moment for CLS to pick up new rules
  await new Promise(r => setTimeout(r, 3000));

  // Test classify
  const text = "Olympic athletes competed in swimming and cycling events.";
  const clsResult = await semaphore.classify(text, 0);
  const cats = clsResult.categories ?? [];
  console.log(`Classification results (${cats.length} categories):`);
  cats.slice(0, 5).forEach(c => console.log(`  [${c.score}] ${c.className}: ${c.value ?? "(no value)"}`));

  if (cats.length > 1) {
    console.log("✅ VARIANT WORKS — multiple rules found!");
    return true;
  }
  return false;
}

async function main() {
  for (const [name, xml] of Object.entries(VARIANTS)) {
    const success = await testVariant(name, xml);
    if (success) {
      console.log(`\n🎉 Winner: ${name}`);
      break;
    }
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
