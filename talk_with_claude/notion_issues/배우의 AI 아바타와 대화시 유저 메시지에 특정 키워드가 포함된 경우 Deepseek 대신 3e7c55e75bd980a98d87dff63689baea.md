# 배우의 AI 아바타와 대화시 유저 메시지에 특정 키워드가 포함된 경우 Deepseek 대신 사전 준비된 템플릿과 /swx API 반환 데이터로 답변

Created time: September 26, 2026 2:56 PM
Sprint: Sprint22 (https://app.notion.com/p/Sprint22-2cdc55e75bd980079521f65c6695ca52?pvs=21)
Related Project: Flix1 v4.0+ (https://app.notion.com/p/Flix1-v4-0-34dc55e75bd980cb9623e8e403e86908?pvs=21)
Related Task: AI를 활용하여 배우 아바타와 채팅 기능 구현 (https://app.notion.com/p/AI-3e1c55e75bd9802ca537c95e13b3fe3f?pvs=21)
Status: Open
Assigned to: Kenny
Type: Feature request
Priority: Highest

## Summary

- 

## AS IS

1. 

## TO BE

유저 메시지에 언어별로 특정 표현 포함되어 있을 경우 그에 맞는 쿼리 조건으로 조회한 결과를 답변에 반영.

1. Uncensored 카테고리 
    1. KO : 노모, 모파, 모자이크 파괴, 모자이크 제거
    2. JA : 無修正, ノーモ, 解禁
    3. EN : Uncensored, Original Uncensored, No Mosaic
    4. ZH : 无码, 原版无码, 无码流出
    5. ID : Tanpa Sensor, No Sensor, Uncensored
    6. MS : Tanpa Sensor, Tiada Sensor, Uncensored
    7. TW : 無碼, 原版無碼, 無碼流出
    8. TH : ไร้เซ็นเซอร์, ไม่เซ็นเซอร์, Uncensored
    9. VI : Không Che, Nguyên Bản Không Che, Uncensored
        
        ```
        find( {favorite_count: {$exists: true}, category_id: "5f7592975c425008d254a789", is_active: 1}).sort(favorite_count: -1)
        ```
        
2. FC2 카테고리 : 언어와 무관하게 키워드는 FC2 
    
    ```
    find( {favorite_count: {$exists: true}, category_id: "606d1f633a5281073f6c18b4", is_active: 1}).sort(favorite_count: -1)
    ```
    
3. Leaked 카테고리
    1. KO : 모파, 모자이크 파괴, 모자이크 제거
    2. JA : モザイク除去, モザイク破壊, AI修復, 漏れ
    3. EN : Mosaic Removed, Decensored, Uncensored Leaked, AI Uncensored
    4. ZH : 去码, 破码, AI修复, AI去码
    5. ID : Hapus Sensor, Hilangkan Sensor, AI No Sensor
    6. MS : Buang Sensor, Hapus Sensor
    7. TW : 去碼, 破碼, AI修復, AI去碼
    8. TH : ลบเซ็นเซอร์, ถอดเซ็นเซอร์, AI ลบเซ็นเซอร์
    9. VI : Xóa Che, Gỡ Che, AI Xóa Che
        
        ```
        find( {favorite_count: {$exists: true}, category_id: "638ba0b6e6248f567f04b84c", is_active: 1}).sort(favorite_count: -1)
        ```