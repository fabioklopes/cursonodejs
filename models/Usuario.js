const db = require('./db');

// tb_usuarios
const Usuario = db.sequelize.define('tb_usuarios', {
    user_code: {
        type: db.Sequelize.STRING(5),
        unique: true,
    },
    first_name: db.Sequelize.STRING,
    last_name: db.Sequelize.STRING,
    email: {
        type: db.Sequelize.STRING,
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    password: {
        type: db.Sequelize.STRING,
        allowNull: false
    },
    reset_token_hash: db.Sequelize.STRING,
    reset_token_expires: db.Sequelize.DATE,
    role: {
        type: db.Sequelize.ENUM('ADM', 'PRO', 'STD'),
        allowNull: false,
        defaultValue: 'STD',
        validate: {
            isIn: [['ADM', 'PRO', 'STD']]
        }
    },
    phone: {
        type: db.Sequelize.CHAR(11),
        allowNull: true,
        validate: {
            is: /^[0-9]{11}$/
        }
    },
    birth_date: {
        type: db.Sequelize.DATEONLY,
        allowNull: false,
        validate: {
            isDate: true,
            isBefore: new Date().toISOString().split('T')[0]
        }
    },
    actual_belt: {
        type: db.Sequelize.ENUM(
            'white',
            'gray_white', 'gray', 'gray_black',
            'yellow_white', 'yellow', 'yellow_black',
            'orange_white', 'orange', 'orange_black',
            'green_white', 'green', 'green_black',
            'blue', 'purple', 'brown', 'black'),
        allowNull: false,
        defaultValue: 'white',
        validate: {
            isIn: [[
                'white', 
                'gray_white', 'gray', 'gray_black', 
                'yellow_white', 'yellow', 'yellow_black', 
                'orange_white', 'orange', 'orange_black', 
                'green_white', 'green', 'green_black', 
                'blue', 'purple', 'brown', 'black'
            ]]
        }
    },
    actual_degree: {
        type: db.Sequelize.ENUM('0', '1', '2', '3', '4', '5', '6'),
        allowNull: false,
        defaultValue: '0',
        validate: {
            isIn: [['0', '1', '2', '3', '4', '5', '6']],
            isValidForSelectedBelt(value) {
                const belt = this.actual_belt;
                const degree = parseInt(value, 10);
                const maxDegree = belt === 'black' ? 6 : 4;

                if (!Number.isInteger(degree) || degree < 0 || degree > maxDegree) {
                    throw new Error(
                        belt === 'black'
                            ? 'Faixa preta permite graus entre 0 e 6.'
                            : 'A faixa selecionada permite graus entre 0 e 4.'
                    );
                }
            }
        }
    },
    wagi_size: {
        type: db.Sequelize.CHAR(3),
        allowNull: false,
    },
    zubon_size: {
        type: db.Sequelize.CHAR(3),
        allowNull: false,
    },
    obi_size: {
        type: db.Sequelize.CHAR(2),
        allowNull: false,
    },
    photo: {
        type: db.Sequelize.STRING,
        allowNull: true,
        validate: {
            is: /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i,
            len: [1, 255],
        },
        defaultValue: '/uploads/users/default.jpg',
    },
    responsible_id: {
        type: db.Sequelize.INTEGER,
        allowNull: true,
    },
    class_code: {
        type: db.Sequelize.STRING(5),
        allowNull: true,
    },
    birthday_messages_disabled: {
        type: db.Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    birthday_messages_disabled_year: {
        type: db.Sequelize.INTEGER,
        allowNull: true
    },
    user_status: {
        type: db.Sequelize.ENUM('P', 'A', 'C'), // Pending, Ativo ou Cancelled
        allowNull: false,
        defaultValue: 'P', // Padrão para "Pendente"
        validate: {
            isIn: [['P', 'A', 'C']] // Validação extra
        }
    }
});



/** 
 * Nota: Use com cuidado em produção, pois pode resultar em perda de dados.
 * Opções válidas:
 * - force: true - Apaga a tabela existente e cria uma nova (perda de dados).
 * - alter: true - Altera a tabela para corresponder ao modelo, sem apagar dados (recomendado para produção).
*/
// Usuario.sync({ alter: true });

module.exports = Usuario;
