import logging
from typing import List

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential
from app.utils.prompts import MEMORY_CATEGORIZATION_PROMPT

load_dotenv()
openai_client = OpenAI()


class MemoryCategories(BaseModel):
    categories: List[str]


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=15))
def get_categories_for_memory(memory: str) -> List[str]:
    """
    Categorize a memory using OpenAI's structured outputs.
    
    Args:
        memory (str): The memory text to categorize
        
    Returns:
        List[str]: List of category names, lowercased and stripped
    """
    try:
        # Use the newer beta.chat.completions.parse method for structured outputs
        completion = openai_client.beta.chat.completions.parse(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": MEMORY_CATEGORIZATION_PROMPT},
                {"role": "user", "content": memory}
            ],
            response_format=MemoryCategories,
            temperature=0
        )

        # Handle refusals - when the model refuses to categorize for safety reasons
        if completion.choices[0].message.refusal:
            logging.warning(f"[WARNING] OpenAI refused to categorize memory: {completion.choices[0].message.refusal}")
            return []

        # Extract the parsed structured response
        parsed_response = completion.choices[0].message.parsed
        
        if parsed_response is None:
            logging.error("[ERROR] Parsed response is None")
            return []

        # Return categories as lowercase and stripped strings
        return [cat.strip().lower() for cat in parsed_response.categories]

    except Exception as e:
        logging.error(f"[ERROR] Failed to get categories: {e}")
        
        # Try to extract raw response for debugging
        try:
            if 'completion' in locals():
                logging.debug(f"[DEBUG] Raw response: {completion.choices[0].message.content}")
        except Exception as debug_e:
            logging.debug(f"[DEBUG] Could not extract raw response: {debug_e}")
        
        raise
