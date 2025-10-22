"""
OpenSearch Dashboard Automation Handler
Automates workspace creation and dashboard setup via OpenSearch UI API
"""

import json
import logging
import time
from typing import Any, Dict, Optional

from sigv4_signer import get_common_headers, make_signed_request, make_domain_request

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_data_source_id(endpoint: str, region: str, domain_name: str) -> Optional[str]:
    """
    Retrieve data source ID by searching for the domain name.
    
    OpenSearch UI automatically creates a data source for connected domains.
    This function finds that data source ID.
    """
    logger.info(f"Searching for data source: {domain_name}")
    url = f"https://{endpoint}/api/saved_objects/_find?type=data-source&per_page=100"
    headers = get_common_headers()
    
    try:
        response = make_signed_request("GET", url, headers, region=region)
        
        if 200 <= response.status_code < 300:
            data = json.loads(response.text)
            saved_objects = data.get("saved_objects", [])
            
            # Find data source matching domain name
            for obj in saved_objects:
                title = obj.get("attributes", {}).get("title", "")
                if domain_name in title or title == domain_name:
                    data_source_id = obj.get("id")
                    logger.info(f"Found data source: {data_source_id}")
                    return data_source_id
            
            logger.warning(f"No data source found for domain: {domain_name}")
            return None
        else:
            logger.error(f"Failed to retrieve data sources: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception getting data source: {str(e)}", exc_info=True)
        return None


def find_workspace_by_name(endpoint: str, region: str, workspace_name: str) -> Optional[str]:
    """Find workspace ID by workspace name."""
    logger.info(f"Searching for workspace: {workspace_name}")
    url = f"https://{endpoint}/api/workspaces/_list"
    headers = get_common_headers()
    
    try:
        response = make_signed_request("POST", url, headers, b"{}", region=region)
        
        if 200 <= response.status_code < 300:
            data = json.loads(response.text)
            
            if not data.get("success"):
                logger.error("API returned success=false when listing workspaces")
                return None
            
            workspaces = data.get("result", {}).get("workspaces", [])
            
            for workspace in workspaces:
                if workspace.get("name") == workspace_name:
                    workspace_id = workspace.get("id")
                    logger.info(f"Found existing workspace: {workspace_id}")
                    return workspace_id
            
            logger.info(f"Workspace '{workspace_name}' not found")
            return None
        else:
            logger.error(f"Failed to list workspaces: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception listing workspaces: {str(e)}", exc_info=True)
        return None


def create_workspace(
    endpoint: str, region: str, data_source_id: str, workspace_name: str
) -> Optional[str]:
    """Create workspace via OpenSearch UI API."""
    logger.info(f"Creating workspace: {workspace_name}")
    url = f"https://{endpoint}/api/workspaces"
    
    request_body = {
        "attributes": {
            "name": workspace_name,
            "color": "#54B399",
            "features": ["use-case-observability"],
        },
        "settings": {
            "dataSources": [data_source_id],
            "dataConnections": [],
            "permissions": {
                "library_write": {"users": ["*"]},
                "write": {"users": ["*"]}
            },
        },
    }
    
    body_bytes = json.dumps(request_body).encode("utf-8")
    headers = get_common_headers(body_bytes)
    
    try:
        response = make_signed_request("POST", url, headers, body_bytes, region=region)
        
        if 200 <= response.status_code < 300:
            response_data = json.loads(response.text)
            
            if not response_data.get("success"):
                logger.error(f"API returned success=false - {response.text}")
                return None
            
            workspace_id = response_data.get("result", {}).get("id")
            
            if workspace_id:
                logger.info(f"Workspace created: {workspace_id}")
            else:
                logger.error("No workspace ID in response")
            
            return workspace_id
        else:
            logger.error(f"Failed to create workspace: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception creating workspace: {str(e)}", exc_info=True)
        return None


def get_or_create_workspace(
    endpoint: str, region: str, data_source_id: str, workspace_name: str
) -> Optional[str]:
    """
    Get existing workspace by name, or create if it doesn't exist (idempotent).
    """
    logger.info(f"Getting or creating workspace: {workspace_name}")
    
    # Check if workspace exists
    workspace_id = find_workspace_by_name(endpoint, region, workspace_name)
    
    if workspace_id:
        logger.info(f"Reusing existing workspace: {workspace_id}")
        return workspace_id
    
    # Create new workspace
    logger.info(f"Creating new workspace: {workspace_name}")
    return create_workspace(endpoint, region, data_source_id, workspace_name)


def generate_sample_metrics(num_docs: int = 50) -> list:
    """
    Generate sample application metrics for demonstration purposes.
    Creates realistic HTTP API request data over the past 24 hours.
    
    Args:
        num_docs: Number of sample documents to generate (default: 50)
    
    Returns:
        List of metric documents
    """
    import random
    from datetime import datetime, timedelta
    
    logger.info(f"Generating {num_docs} sample metrics")
    
    # Configuration for realistic data
    endpoints = [
        "/api/users",
        "/api/products", 
        "/api/orders",
        "/api/auth/login",
        "/api/health"
    ]
    
    http_methods = ["GET", "POST", "PUT", "DELETE"]
    status_codes = [200, 201, 400, 404, 500]
    status_weights = [0.70, 0.15, 0.08, 0.05, 0.02]  # Most requests succeed
    
    # Generate documents spread over last 24 hours
    now = datetime.utcnow()
    documents = []
    
    for i in range(num_docs):
        # Random timestamp in last 24 hours
        hours_ago = random.uniform(0, 24)
        timestamp = now - timedelta(hours=hours_ago)
        
        # Select endpoint and method
        endpoint = random.choice(endpoints)
        method = random.choice(http_methods)
        
        # Status code with realistic distribution
        status_code = random.choices(status_codes, weights=status_weights)[0]
        
        # Response time based on status (errors are faster)
        if status_code >= 400:
            response_time = random.randint(10, 100)
        else:
            response_time = random.randint(20, 500)
        
        doc = {
            "@timestamp": timestamp.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "service": "api-gateway",
            "endpoint": endpoint,
            "http_method": method,
            "status_code": status_code,
            "response_time_ms": response_time,
            "region": "us-west-2",
            "success": status_code < 400
        }
        
        documents.append(doc)
    
    # Sort by timestamp (oldest first)
    documents.sort(key=lambda x: x["@timestamp"])
    
    logger.info(f"Generated {len(documents)} documents")
    return documents


def ingest_sample_data(
    domain_endpoint: str, 
    region: str,
    documents: list
) -> bool:
    """
    Ingest sample documents into OpenSearch domain using bulk API.
    
    Args:
        domain_endpoint: OpenSearch domain endpoint (e.g., search-xxx.region.es.amazonaws.com)
        region: AWS region
        documents: List of documents to ingest
    
    Returns:
        True if ingestion successful, False otherwise
    """
    from datetime import datetime
    index_name = f"application-metrics-{datetime.utcnow().strftime('%Y.%m.%d')}"
    logger.info(f"Ingesting {len(documents)} documents to index: {index_name}")
    
    # Build bulk request body
    # Format: {"index": {"_index": "index-name"}}\n{document}\n
    bulk_body_lines = []
    for doc in documents:
        bulk_body_lines.append(json.dumps({"index": {"_index": index_name}}))
        bulk_body_lines.append(json.dumps(doc))
    
    bulk_body = "\n".join(bulk_body_lines) + "\n"
    body_bytes = bulk_body.encode("utf-8")
    
    # Make request directly to OpenSearch domain bulk endpoint
    # Uses 'es' service name for SigV4 signing (not 'opensearch')
    url = f"https://{domain_endpoint}/_bulk"
    headers = {"Content-Type": "application/x-ndjson"}
    
    try:
        response = make_domain_request("POST", url, headers, body_bytes, region=region)
        
        if 200 <= response.status_code < 300:
            response_data = json.loads(response.text)
            
            # Check for errors in bulk response
            if response_data.get("errors"):
                error_count = sum(1 for item in response_data.get("items", []) 
                                if "error" in item.get("index", {}))
                logger.warning(f"Bulk ingestion had {error_count} errors")
                # Log first error for debugging
                for item in response_data.get("items", [])[:1]:
                    if "error" in item.get("index", {}):
                        logger.error(f"Sample error: {item['index']['error']}")
            
            success_count = len(documents) - response_data.get("errors", 0)
            logger.info(f"Ingested {success_count}/{len(documents)} documents to {index_name}")
            return True
        else:
            logger.error(f"Bulk ingest failed: HTTP {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"Exception during bulk ingest: {str(e)}", exc_info=True)
        return False


def create_index_pattern(
    endpoint: str,
    region: str,
    workspace_id: str,
    data_source_id: str
) -> Optional[str]:
    """
    Create index pattern for application metrics.
    References the data source to connect to the correct OpenSearch domain.
    
    Args:
        endpoint: OpenSearch UI endpoint
        region: AWS region
        workspace_id: Workspace ID
        data_source_id: Data source ID to reference
    
    Returns:
        Index pattern ID if successful, None otherwise
    """
    logger.info("Creating index pattern: application-metrics-*")
    url = f"https://{endpoint}/w/{workspace_id}/api/saved_objects/index-pattern"
    request_body = {
        "attributes": {
            "title": "application-metrics-*",
            "timeFieldName": "@timestamp"
        },
        "references": [
            {
                "id": data_source_id,
                "type": "data-source",
                "name": "dataSource"
            }
        ]
    }
    
    body_bytes = json.dumps(request_body).encode("utf-8")
    headers = get_common_headers(body_bytes)
    
    try:
        response = make_signed_request("POST", url, headers, body_bytes, region=region)
        
        if 200 <= response.status_code < 300:
            response_data = json.loads(response.text)
            index_pattern_id = response_data.get("id")
            logger.info(f"Index pattern created: {index_pattern_id}")
            return index_pattern_id
        else:
            logger.error(f"Failed to create index pattern: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception creating index pattern: {str(e)}", exc_info=True)
        return None


def create_visualization(
    endpoint: str,
    region: str,
    workspace_id: str,
    index_pattern_id: str
) -> Optional[str]:
    """
    Create a pie chart visualization showing HTTP status code distribution.
    
    Args:
        endpoint: OpenSearch UI endpoint
        region: AWS region
        workspace_id: Workspace ID
        index_pattern_id: Index pattern ID
    
    Returns:
        Visualization ID if successful, None otherwise
    """
    logger.info("Creating pie chart visualization for status codes")
    url = f"https://{endpoint}/w/{workspace_id}/api/saved_objects/visualization"
    
    # Pie chart showing status code distribution
    vis_state = {
        "title": "HTTP Status Code Distribution",
        "type": "pie",
        "params": {
            "type": "pie",
            "addTooltip": True,
            "addLegend": True,
            "legendPosition": "right",
            "isDonut": False,
            "labels": {
                "show": True,
                "values": True,
                "last_level": True,
                "truncate": 100
            }
        },
        "aggs": [
            {
                "id": "1",
                "enabled": True,
                "type": "count",
                "schema": "metric",
                "params": {}
            },
            {
                "id": "2",
                "enabled": True,
                "type": "terms",
                "schema": "segment",
                "params": {
                    "field": "status_code",
                    "size": 10,
                    "order": "desc",
                    "orderBy": "1"
                }
            }
        ]
    }
    
    request_body = {
        "attributes": {
            "title": "HTTP Status Code Distribution",
            "visState": json.dumps(vis_state),
            "uiStateJSON": "{}",
            "description": "Pie chart showing distribution of HTTP status codes",
            "version": 1,
            "kibanaSavedObjectMeta": {
                "searchSourceJSON": json.dumps({
                    "index": index_pattern_id,
                    "query": {"query": "", "language": "kuery"},
                    "filter": []
                })
            }
        }
    }
    
    body_bytes = json.dumps(request_body).encode("utf-8")
    headers = get_common_headers(body_bytes)
    
    try:
        response = make_signed_request("POST", url, headers, body_bytes, region=region)
        
        if 200 <= response.status_code < 300:
            response_data = json.loads(response.text)
            vis_id = response_data.get("id")
            logger.info(f"Visualization created: {vis_id}")
            return vis_id
        else:
            logger.error(f"Failed to create visualization: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception creating visualization: {str(e)}", exc_info=True)
        return None


def create_dashboard(
    endpoint: str,
    region: str,
    workspace_id: str,
    visualization_id: str
) -> Optional[str]:
    """
    Create a simple dashboard with one visualization panel.
    
    Args:
        endpoint: OpenSearch UI endpoint
        region: AWS region
        workspace_id: Workspace ID
        visualization_id: Visualization ID
    
    Returns:
        Dashboard ID if successful, None otherwise
    """
    logger.info("Creating dashboard with visualization")
    url = f"https://{endpoint}/w/{workspace_id}/api/saved_objects/dashboard"
    
    # Single panel layout
    panels = [
        {
            "version": "2.11.0",
            "gridData": {"x": 0, "y": 0, "w": 24, "h": 15, "i": "1"},
            "panelIndex": "1",
            "embeddableConfig": {},
            "panelRefName": "panel_0"
        }
    ]
    
    request_body = {
        "attributes": {
            "title": "Application Metrics",
            "hits": 0,
            "description": "Simple dashboard showing API metrics",
            "panelsJSON": json.dumps(panels),
            "optionsJSON": json.dumps({"useMargins": True, "hidePanelTitles": False}),
            "version": 1,
            "timeRestore": False,
            "kibanaSavedObjectMeta": {
                "searchSourceJSON": json.dumps({
                    "query": {"query": "", "language": "kuery"},
                    "filter": []
                })
            }
        },
        "references": [
            {"name": "panel_0", "type": "visualization", "id": visualization_id}
        ]
    }
    
    body_bytes = json.dumps(request_body).encode("utf-8")
    headers = get_common_headers(body_bytes)
    
    try:
        response = make_signed_request("POST", url, headers, body_bytes, region=region)
        
        if 200 <= response.status_code < 300:
            response_data = json.loads(response.text)
            dashboard_id = response_data.get("id")
            logger.info(f"Dashboard created: {dashboard_id}")
            return dashboard_id
        else:
            logger.error(f"Failed to create dashboard: HTTP {response.status_code} - {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Exception creating dashboard: {str(e)}", exc_info=True)
        return None


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    CloudFormation Custom Resource handler for dashboard automation.
    
    Uses CDK Provider Framework pattern:
    - Returns simple dictionary with Data field
    - Provider Framework handles CloudFormation communication
    - Exceptions automatically caught and reported as FAILED
    """
    logger.info("Lambda invocation started")
    
    request_type = event.get("RequestType", "Create")
    properties = event.get("ResourceProperties", {})
    
    opensearch_ui_endpoint = properties.get("opensearchUIEndpoint")
    domain_name = properties.get("domainName")
    workspace_name = properties.get("workspaceName")
    region = properties.get("region")
    
    logger.info(f"Request: {request_type} | Domain: {domain_name} | Workspace: {workspace_name} | Region: {region}")
    
    # Handle delete requests
    if request_type == "Delete":
        logger.info("Delete request received - workspace persists (no-op)")
        return {
            "Data": {
                "WorkspaceId": "n/a",
                "DataSourceId": "n/a",
            }
        }
    
    # Handle create/update requests
    try:
        # Get data source ID for the OpenSearch domain
        data_source_id = get_data_source_id(opensearch_ui_endpoint, region, domain_name)
        if not data_source_id:
            raise RuntimeError(f"Data source not found for domain: {domain_name}")
        
        # Create workspace with data source (idempotent)
        workspace_id = get_or_create_workspace(
            opensearch_ui_endpoint, region, data_source_id, workspace_name
        )
        if not workspace_id:
            raise RuntimeError("Failed to get or create workspace")
        
        # Generate and ingest sample data
        domain_endpoint = properties.get("domainEndpoint")
        sample_documents = []
        if not domain_endpoint:
            logger.warning("Domain endpoint not provided, skipping sample data ingestion")
        else:
            sample_documents = generate_sample_metrics(num_docs=50)
            ingest_success = ingest_sample_data(domain_endpoint, region, sample_documents)
            if not ingest_success:
                logger.warning("Sample data ingestion failed, but continuing")
        
        # Create index pattern, visualization, and dashboard
        index_pattern_id = create_index_pattern(
            opensearch_ui_endpoint, region, workspace_id, data_source_id
        )
        if not index_pattern_id:
            logger.warning("Index pattern creation failed, skipping visualization and dashboard")
        else:
            visualization_id = create_visualization(
                opensearch_ui_endpoint, region, workspace_id, index_pattern_id
            )
            if not visualization_id:
                logger.warning("Visualization creation failed, skipping dashboard")
            else:
                dashboard_id = create_dashboard(
                    opensearch_ui_endpoint, region, workspace_id, visualization_id
                )
                if not dashboard_id:
                    logger.warning("Dashboard creation failed")
        
        logger.info(f"Lambda execution completed - Workspace: {workspace_id} | Data Source: {data_source_id} | Documents: {len(sample_documents)}")
        
        # Return for Provider Framework - all values must be strings!
        return {
            "Data": {
                "WorkspaceId": workspace_id,
                "DataSourceId": data_source_id,
            }
        }
        
    except Exception as error:
        logger.error(f"Lambda execution failed: {str(error)}", exc_info=True)
        raise
