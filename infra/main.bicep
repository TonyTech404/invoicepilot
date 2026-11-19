// InvoicePilot infrastructure.
// Deploy: az deployment group create -g rg-invoicepilot -f infra/main.bicep -p infra/main.bicepparam
targetScope = 'resourceGroup'

@description('Short name used to derive resource names.')
param appName string = 'invoicepilot'

@description('Region for the AI services and monitoring.')
param location string = resourceGroup().location

@description('Static Web Apps is only offered in a few regions; East Asia sits between Manila and Sydney.')
param webLocation string = 'eastasia'

@description('Azure OpenAI model used to code invoice lines to accounts.')
param openAiModel string = 'gpt-5.4-mini'
param openAiModelVersion string = '2026-03-17'

@description('Deployment type. DataZoneStandard keeps processing inside the data zone.')
param openAiSku string = 'DataZoneStandard'

@description('Thousands of tokens per minute for the model deployment.')
param openAiCapacity int = 50

@secure()
@description('Neon Postgres connection string (pooled).')
param databaseUrl string

@secure()
@description('Shared secret the scheduled GitHub Action sends to /api/sync/run.')
param cronSecret string

@secure()
@description('Shared with the Cloudflare Worker on the custom domain, so the API can trust the visitor IP it forwards.')
param proxyKey string = ''

@description('Who gets the budget alerts. Leave empty to skip the budget.')
param budgetEmail string = ''

@description('Monthly budget in USD.')
param budgetAmount int = 5

@description('First day of the current month, yyyy-MM-01. Budgets need a start date.')
param budgetStartDate string = '2026-11-01'

var suffix = uniqueString(resourceGroup().id)
var tags = {
  app: appName
  managedBy: 'bicep'
}

// ── Monitoring ────────────────────────────────────────────────────────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}-${suffix}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ── Document Intelligence (free tier: 500 pages a month) ────────────────────
resource docIntel 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'di-${appName}-${suffix}'
  location: location
  kind: 'FormRecognizer'
  sku: { name: 'F0' }
  tags: tags
  properties: {
    customSubDomainName: 'di-${appName}-${suffix}'
    publicNetworkAccess: 'Enabled'
  }
}

// ── Azure OpenAI ─────────────────────────────────────────────────────────────
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'oai-${appName}-${suffix}'
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  tags: tags
  properties: {
    customSubDomainName: 'oai-${appName}-${suffix}'
    publicNetworkAccess: 'Enabled'
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: 'coder'
  sku: {
    name: openAiSku
    capacity: openAiCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: openAiModel
      version: openAiModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

// ── Web app + API (Static Web Apps, free plan with managed Functions) ───────
resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-${appName}-${suffix}'
  location: webLocation
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

resource webSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: web
  name: 'appsettings'
  properties: {
    DATABASE_URL: databaseUrl
    CRON_SECRET: cronSecret
    PROXY_KEY: proxyKey
    DOCINTEL_ENDPOINT: docIntel.properties.endpoint
    DOCINTEL_KEY: docIntel.listKeys().key1
    AOAI_ENDPOINT: openAi.properties.endpoint
    AOAI_KEY: openAi.listKeys().key1
    AOAI_DEPLOYMENT: model.name
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
  }
}

// ── Budget alert (the subscription is pay-as-you-go) ─────────────────────────
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(budgetEmail)) {
  name: 'budget-${appName}'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [ budgetEmail ]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [ budgetEmail ]
      }
    }
  }
}

output webName string = web.name
output webHostname string = web.properties.defaultHostname
output docIntelEndpoint string = docIntel.properties.endpoint
output openAiEndpoint string = openAi.properties.endpoint
output openAiDeployment string = model.name
output insightsName string = insights.name
