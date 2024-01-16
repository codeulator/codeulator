import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';
import Kotlin from 'tree-sitter-kotlin';
import C from 'tree-sitter-c';
import CPlusPlus from 'tree-sitter-cpp';
import Rust from 'tree-sitter-rust';
import Ruby from 'tree-sitter-ruby';
import PHP from 'tree-sitter-php';
import CSharp from 'tree-sitter-c-sharp';

const languages = {
    '.js': { id: 'javascript', parser: JavaScript },
    '.jsx': { id: 'javascript', parser: JavaScript },
    '.ts': { id: 'typescript', parser: TypeScript.typescript },
    '.tsx': { id: 'typescript', parser: TypeScript.tsx },
    '.py': { id: 'python', parser: Python },
    '.go': { id: 'go', parser: Go },
    '.swift': { id: 'swift', parser: undefined },
    '.java': { id: 'java', parser: Java },
    '.kt': { id: 'kotlin', parser: Kotlin },
    '.kts': { id: 'kotlin', parser: Kotlin },
    '.c': { id: 'c', parser: C },
    '.h': { id: 'cpp', parser: CPlusPlus },
    '.cpp': { id: 'cpp', parser: CPlusPlus },
    '.cxx': { id: 'cpp', parser: CPlusPlus },
    '.cc': { id: 'cpp', parser: CPlusPlus },
    '.hpp': { id: 'cpp', parser: CPlusPlus },
    '.hh': { id: 'cpp', parser: CPlusPlus },
    '.hxx': { id: 'cpp', parser: CPlusPlus },
    //'.rs': { id: 'rust', parser: Rust },
    '.rb': { id: 'ruby', parser: Ruby },
    '.rbw': { id: 'ruby', parser: Ruby },
    '.php': { id: 'php', parser: PHP },
    '.cs': { id: 'csharp', parser: CSharp },
    '.yml': { id: 'yaml', parser: undefined },
    '.yaml': { id: 'yaml', parser: undefined },
};

export default languages;
