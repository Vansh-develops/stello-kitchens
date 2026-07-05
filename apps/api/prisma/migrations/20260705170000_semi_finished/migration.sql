-- AlterTable: flag in-house produced materials
ALTER TABLE "raw_materials" ADD COLUMN "isSemiFinished" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "prep_recipe_ingredients" (
    "id" TEXT NOT NULL,
    "outputMaterialId" TEXT NOT NULL,
    "inputMaterialId" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    CONSTRAINT "prep_recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prep_recipe_ingredients_outputMaterialId_inputMaterialId_key" ON "prep_recipe_ingredients"("outputMaterialId", "inputMaterialId");

-- AddForeignKey
ALTER TABLE "prep_recipe_ingredients" ADD CONSTRAINT "prep_recipe_ingredients_outputMaterialId_fkey" FOREIGN KEY ("outputMaterialId") REFERENCES "raw_materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prep_recipe_ingredients" ADD CONSTRAINT "prep_recipe_ingredients_inputMaterialId_fkey" FOREIGN KEY ("inputMaterialId") REFERENCES "raw_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
