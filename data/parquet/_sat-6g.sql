
-- sat-6g: 9940 实体
CREATE TABLE IF NOT EXISTS entities_sat-6g AS
SELECT
  id,
  name,
  source,
  COALESCE(abstract, '') AS abstract,
  url,
  COALESCE(json_array_to_text_array(authors, ','), '') AS authors,
  COALESCE(json_array_to_text_array(tags, ','), '') AS tags,
  COALESCE(confidence, 0.5) AS confidence,
  COALESCE(json_array_to_text_array(sites, ','), '') AS sites,
  COALESCE(publishedDate, '') AS publishedDate,
  COALESCE(doi, '') AS doi,
  COALESCE(addedAt, '') AS addedAt,
  COALESCE(updatedAt, '') AS updatedAt,
  COALESCE(quality_tier, '') AS quality_tier
FROM read_json_auto('C:///Users/xing/Desktop/知识引擎14站/data/parquet/_sat-6g.json');

COPY entities_sat-6g TO 'C:/Users/xing/Desktop/知识引擎14站/data/parquet/sat-6g.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

DROP TABLE entities_sat-6g;
