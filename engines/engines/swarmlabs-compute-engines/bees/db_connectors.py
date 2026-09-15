"""外部科学数据库连接器 — 对标Claude Science的60+数据库预置"""
import urllib.request, json, urllib.parse

class PubMedConnector:
    """PubMed API连接器"""
    def search(self, query, max_results=5):
        try:
            url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={urllib.parse.quote(query)}&retmax={max_results}&retmode=json"
            req = urllib.request.Request(url, headers={'User-Agent': 'SwarmResearch/1.0'})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            ids = data.get('esearchresult', {}).get('idlist', [])
            if not ids:
                return []
            # 获取摘要
            sum_url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={','.join(ids)}&retmode=json"
            with urllib.request.urlopen(urllib.request.Request(sum_url, headers={'User-Agent': 'SwarmResearch/1.0'}), timeout=10) as r:
                sum_data = json.loads(r.read())
            results = []
            for pmid in ids:
                article = sum_data.get('result', {}).get(pmid, {})
                results.append({
                    'source': 'PubMed',
                    'pmid': pmid,
                    'title': article.get('title', ''),
                    'authors': [a.get('name', '') for a in article.get('authors', [])][:3],
                    'journal': article.get('fulljournalname', ''),
                    'pubdate': article.get('pubdate', ''),
                    'url': f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/'
                })
            return results
        except Exception as e:
            return [{'source': 'PubMed', 'error': str(e)[:50]}]

class ChEMBLConnector:
    """ChEMBL API连接器"""
    def search(self, query, max_results=5):
        try:
            url = f"https://www.ebi.ac.uk/chembl/api/data/molecule.json?molecule_synonyms__molecule_synonym__icontains={urllib.parse.quote(query)}&limit={max_results}"
            req = urllib.request.Request(url, headers={'User-Agent': 'SwarmResearch/1.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            results = []
            for mol in data.get('molecules', []):
                mcf = mol.get('molecule_chembl_id', '')
                props = mol.get('molecule_properties', {})
                results.append({
                    'source': 'ChEMBL',
                    'chembl_id': mcf,
                    'name': mol.get('pref_name', 'Unknown'),
                    'mw': props.get('full_mwt', ''),
                    'logp': props.get('alogp', ''),
                    'url': f'https://www.ebi.ac.uk/chembl/compound_report_card/{mcf}/'
                })
            return results
        except Exception as e:
            return [{'source': 'ChEMBL', 'error': str(e)[:50]}]

class PubChemConnector:
    """PubChem API连接器"""
    def search(self, query, max_results=5):
        try:
            url = f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{urllib.parse.quote(query)}/property/MolecularFormula,MolecularWeight,CanonicalSMILES/JSON"
            req = urllib.request.Request(url, headers={'User-Agent': 'SwarmResearch/1.0'})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            results = []
            for comp in data.get('PropertyTable', {}).get('Properties', [])[:max_results]:
                results.append({
                    'source': 'PubChem',
                    'cid': comp.get('CID', ''),
                    'formula': comp.get('MolecularFormula', ''),
                    'mw': comp.get('MolecularWeight', ''),
                    'smiles': comp.get('CanonicalSMILES', ''),
                    'url': f'https://pubchem.ncbi.nlm.nih.gov/compound/{comp.get("CID", "")}'
                })
            return results
        except Exception as e:
            return [{'source': 'PubChem', 'error': str(e)[:50]}]

class DOIConnector:
    """CrossRef DOI连接器——验证引用真实性"""
    def verify(self, doi):
        try:
            url = f"https://api.crossref.org/works/{urllib.parse.quote(doi)}"
            req = urllib.request.Request(url, headers={'User-Agent': 'SwarmResearch/1.0'})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            msg = data.get('message', {})
            return {
                'valid': True,
                'doi': doi,
                'title': msg.get('title', [''])[0] if msg.get('title') else '',
                'journal': msg.get('container-title', [''])[0] if msg.get('container-title') else '',
                'authors': [f"{a.get('given','')} {a.get('family','')}" for a in msg.get('author', [])][:3],
                'pubdate': msg.get('published', {}).get('date-parts', [['']])[0][0] if msg.get('published') else '',
                'cited_by': msg.get('is-referenced-by-count', 0)
            }
        except:
            return {'valid': False, 'doi': doi, 'error': 'DOI不存在或无法验证'}

# 连接器注册表——对标Claude Science的60+数据库
CONNECTORS = {
    'pubmed': PubMedConnector(),
    'chembl': ChEMBLConnector(),
    'pubchem': PubChemConnector(),
    'doi': DOIConnector()
}

def search_all(query, max_per_source=3):
    """并行搜索所有数据库——3秒超时"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    all_results = []
    
    def safe_search(name, conn):
        try:
            results = conn.search(query, max_per_source)
            for r in results:
                r['database'] = name
            return results
        except:
            return []
    
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {}
        for name, conn in CONNECTORS.items():
            if name == 'doi':
                continue
            futures[executor.submit(safe_search, name, conn)] = name
        
        for future in as_completed(futures, timeout=5):
            try:
                results = future.result(timeout=3)
                all_results.extend(results)
            except:
                pass
    
    return all_results

def verify_citation(doi):
    """验证DOI引用真实性"""
    return CONNECTORS['doi'].verify(doi)
