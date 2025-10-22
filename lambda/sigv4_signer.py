"""
AWS SigV4 Request Signer for OpenSearch UI APIs

OpenSearch UI APIs require SigV4 signing with the service name 'opensearch'
(different from the traditional 'es' service name used for OpenSearch domains).

CRITICAL Headers:
- osd-xsrf: CSRF protection
- osd-version: API version compatibility  
- x-amz-content-sha256: Body hash for SigV4
"""

import hashlib
import json
from typing import Any, Dict

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.httpsession import URLLib3Session


def get_common_headers(body: bytes = b"{}") -> Dict[str, str]:
    """
    Get common headers for OpenSearch UI API requests.
    
    Args:
        body: Request body bytes to hash
        
    Returns:
        Dictionary of required headers
    """
    body_hash = hashlib.sha256(body).hexdigest()
    return {
        "Content-Type": "application/json",
        "x-amz-content-sha256": body_hash,
        "osd-xsrf": "osd-fetch",
        "osd-version": "3.1.0",
    }


def make_signed_request(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: bytes = b"",
    region: str = None,
) -> Any:
    """
    Make a signed HTTP request to OpenSearch UI API.
    
    Uses botocore's URLLib3Session (not requests library) for proper SigV4 signing.
    
    Args:
        method: HTTP method (GET, POST, PUT, DELETE, etc.)
        url: Full URL to request
        headers: Request headers (should include headers from get_common_headers())
        body: Request body as bytes
        region: AWS region (defaults to session region)
        
    Returns:
        HTTP response object from URLLib3Session
    """
    session = boto3.Session()
    if not region:
        region = session.region_name
    
    # Create AWS request
    request = AWSRequest(method=method, url=url, data=body, headers=headers)
    
    # Sign with SigV4 using 'opensearch' service name (not 'es')
    credentials = session.get_credentials()
    SigV4Auth(credentials, "opensearch", region).add_auth(request)
    
    # Send request using URLLib3Session
    http_session = URLLib3Session()
    return http_session.send(request.prepare())


def make_domain_request(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: bytes = b"",
    region: str = None,
) -> Any:
    """
    Make a signed HTTP request to OpenSearch Domain (not UI).
    
    Uses 'es' service name for signing domain requests (different from UI API).
    
    Args:
        method: HTTP method (GET, POST, PUT, DELETE, etc.)
        url: Full URL to OpenSearch domain
        headers: Request headers
        body: Request body as bytes
        region: AWS region (defaults to session region)
        
    Returns:
        HTTP response object from URLLib3Session
    """
    session = boto3.Session()
    if not region:
        region = session.region_name
    
    # Create AWS request
    request = AWSRequest(method=method, url=url, data=body, headers=headers)
    
    # Sign with SigV4 using 'es' service name for domain requests
    credentials = session.get_credentials()
    SigV4Auth(credentials, "es", region).add_auth(request)
    
    # Send request using URLLib3Session
    http_session = URLLib3Session()
    return http_session.send(request.prepare())
