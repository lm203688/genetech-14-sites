-- 合并全部 30 站到单一 Parquet
CREATE TABLE all_entities AS
SELECT * FROM read_parquet('C:/Users/xing/Desktop/知识引擎14站/data/parquet/*.parquet');

COPY all_entities TO 'C:/Users/xing/Desktop/知识引擎14站/data/parquet/all.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

DROP TABLE all_entities;